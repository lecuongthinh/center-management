// Guarded writer cho module Điểm danh/Ghi danh/Lớp/Giáo viên — ghi THẬT vào GHL, nhưng chỉ vào những bản
// ghi nằm trong allowlist của ĐÚNG khách hàng (location) đang gọi.
//
// Đợt "multi-tenant": trước đây cả file này chỉ phục vụ 1 khách (PIT/location/allowlist đọc 1 LẦN lúc
// module load, dùng chung cho mọi request). Giờ 1 server phục vụ NHIỀU khách hàng cùng lúc — mỗi hàm xuất ra
// nhận thêm `locationId` làm tham số ĐẦU TIÊN, và state riêng của từng khách (PIT, allowlist Ghi danh/Lớp/
// Học viên...) được cache theo locationId trong `tenantStates`, nạp CHẬM (lazy) lần đầu 1 khách nào đó gọi,
// tra `platform.tenants` (xem db.mjs) để biết PIT/schema của khách đó là gì.
import { kvGet, getTenantByLocation } from "./db.mjs";
const BASE = "https://services.leadconnectorhq.com";

const HOC_VIEN_KEY = "custom_objects.hoc_vien";
const DIEM_DANH_KEY = "custom_objects.diem_danh";
const BUOI_HOC_KEY = "custom_objects.buoi_hoc";
const GHI_DANH_KEY = "custom_objects.ghi_danh";
const ASSOC_GHIDANH_DIEMDANH = "6ab39e684e8364ebc07756f1"; // first=diem_danh, second=ghi_danh
const ASSOC_LOP_BUOIHOC = "6ab3c46b6250491d024de50d"; // first=buoi_hoc, second=lop (GHL swapped on create)
const ASSOC_BUOIHOC_DIEMDANH = "6ab3c46c7623c1ecbf662465"; // first=buoi_hoc, second=diem_danh
const ASSOC_HOCVIEN_GHIDANH = "6ab384818dc4a5dea60ea7b7"; // first=ghi_danh, second=hoc_vien
const ASSOC_LOP_GHIDANH = "6ab384837623c1ecbf348b17"; // first=ghi_danh, second=lop
const GIAO_VIEN_KEY = "custom_objects.giao_vien";
const ASSOC_LOP_GIAOVIEN = "6ab40a09c8e7e6b34b1b4d23"; // first=giao_vien, second=lop (GHL swapped on create)
const STATUS_LABEL = { co_mat: "Có mặt", vang_co_phep: "Vắng có phép", vang_khong_phep: "Vắng không phép", den_muon: "Đến muộn" };

// State riêng của 1 khách hàng (locationId): PIT/allowlist, cache trong tiến trình — nạp 1 lần, dùng lại cho
// mọi request sau của CÙNG khách đó, y hệt cách bản 1-khách cũ nạp 1 lần lúc khởi động, chỉ khác là giờ có
// NHIỀU bộ nhớ đệm như vậy song song (1 bộ/khách) thay vì 1 bộ duy nhất.
const tenantStates = new Map();
async function getTenantState(locationId) {
  if (tenantStates.has(locationId)) return tenantStates.get(locationId);
  const tenant = await getTenantByLocation(locationId);
  if (!tenant) throw new Error(`Không tìm thấy cấu hình khách hàng cho location ${locationId} — chưa được thêm vào platform.tenants`);
  const candy = await kvGet(tenant.schema_name, "base_snapshot", { students: [], classes: [], attendance_seed: [] });
  const enrollOverlay = await kvGet(tenant.schema_name, "enrollment_overlay", []);
  const allKnownStudents = [...candy.students, ...enrollOverlay];
  const state = {
    PIT: tenant.ghl_pit,
    LOC: locationId,
    schemaName: tenant.schema_name,
    ALLOWED_GHI_DANH: new Set(allKnownStudents.map((s) => s.ghi_danh_id)),
    ALLOWED_LOP: new Map(candy.classes.map((c) => [c.lop, c.lop_id])),
    ALLOWED_HOC_VIEN: new Set(allKnownStudents.map((s) => s.hoc_vien_id)),
    buoiHocCache: new Map(), // `${lop}|${date}` -> {buoiHocId, created}, tránh gọi search lặp lại trong cùng 1 lô
  };
  tenantStates.set(locationId, state);
  return state;
}

export async function writerEnabled(locationId) {
  try { const t = await getTenantState(locationId); return Boolean(t.PIT); }
  catch { return false; }
}

async function ghl(t, method, path, body) {
  const H = { Authorization: `Bearer ${t.PIT}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" };
  const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`GHL ${method} ${path.replace(/\/records\/[^/]+/, "/records/<id>")} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Buổi học = 1 real session of 1 Lớp on 1 date. Find-or-create so marking attendance twice for the
// same lớp+ngày never creates a duplicate session record — the search is the idempotency check.
async function findOrCreateBuoiHoc(t, { lop, date }) {
  const lopId = t.ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const cacheKey = `${lop}|${date}`;
  if (t.buoiHocCache.has(cacheKey)) return t.buoiHocCache.get(cacheKey);
  const name = `Buổi ${lop} ${date}`;
  const search = await ghl(t, "POST", `/objects/${BUOI_HOC_KEY}/records/search`, { locationId: t.LOC, page: 1, pageLimit: 5, query: name });
  const found = (search.records || []).find((r) => r.properties?.name === name);
  let buoiHocId, created;
  if (found) {
    buoiHocId = found.id; created = false;
  } else {
    const rec = await ghl(t, "POST", `/objects/${BUOI_HOC_KEY}/records`, { locationId: t.LOC, properties: { name, ngay: date, trang_thai: "binh_thuong" } });
    buoiHocId = rec.record.id; created = true;
    await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: ASSOC_LOP_BUOIHOC, firstRecordId: buoiHocId, secondRecordId: lopId });
  }
  const result = { buoiHocId, created };
  t.buoiHocCache.set(cacheKey, result);
  return result;
}

export async function generateSessions(locationId, { lop, dates }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const results = [];
  for (const date of dates) {
    const { buoiHocId, created } = await findOrCreateBuoiHoc(t, { lop, date });
    results.push({ date, buoiHocId, created });
  }
  return results;
}

// Đồng bộ CRM: mỗi Học viên đã được nối với 1 Contact (phụ huynh) — read-only, no side effects.
export async function getPhuHuynh(locationId, { hocVienId }) {
  const t = await getTenantState(locationId);
  if (!t.ALLOWED_HOC_VIEN.has(hocVienId)) throw new Error(`Chặn: ${hocVienId} không nằm trong danh sách Học viên test được phép`);
  const rel = await ghl(t, "GET", `/associations/relations/${hocVienId}?locationId=${t.LOC}`);
  const contactRel = (rel.relations || []).find((r) => r.firstObjectKey === "contact");
  if (!contactRel) return null;
  const c = await ghl(t, "GET", `/contacts/${contactRel.firstRecordId}`);
  const contact = c.contact;
  if (!contact) return null;
  return { id: contact.id, name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(), phone: contact.phone || "", email: contact.email || "", tags: contact.tags || [] };
}

export async function getBuoiHoc(locationId, { lop, date }) {
  const t = await getTenantState(locationId);
  if (!t.ALLOWED_LOP.has(lop)) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const name = `Buổi ${lop} ${date}`;
  const search = await ghl(t, "POST", `/objects/${BUOI_HOC_KEY}/records/search`, { locationId: t.LOC, page: 1, pageLimit: 5, query: name });
  const found = (search.records || []).find((r) => r.properties?.name === name);
  if (!found) return null;
  return { id: found.id, ngay: found.properties?.ngay, trang_thai: found.properties?.trang_thai, giao_vien_day: found.properties?.giao_vien_day || "" };
}

export async function listBuoiHoc(locationId, { lop }) {
  const t = await getTenantState(locationId);
  if (!t.ALLOWED_LOP.has(lop)) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const prefix = `Buổi ${lop} `;
  const search = await ghl(t, "POST", `/objects/${BUOI_HOC_KEY}/records/search`, { locationId: t.LOC, page: 1, pageLimit: 100, query: lop });
  return (search.records || [])
    .filter((r) => (r.properties?.name || "").startsWith(prefix))
    .map((r) => ({ id: r.id, ngay: r.properties?.ngay || "", trang_thai: r.properties?.trang_thai || "binh_thuong", giao_vien_day: r.properties?.giao_vien_day || "" }))
    .sort((a, b) => a.ngay.localeCompare(b.ngay));
}

export async function updateBuoiHoc(locationId, { buoiHocId, trangThai, giaoVienDay }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const props = {};
  if (trangThai) {
    if (!["binh_thuong", "huy", "hoc_bu"].includes(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
    props.trang_thai = trangThai;
  }
  if (giaoVienDay !== undefined) props.giao_vien_day = giaoVienDay;
  if (!Object.keys(props).length) throw new Error("Không có gì để cập nhật");
  await ghl(t, "PUT", `/objects/${BUOI_HOC_KEY}/records/${buoiHocId}?locationId=${t.LOC}`, { properties: props });
  return { buoiHocId, ...props };
}

export async function setBuoiHocTrangThai(locationId, { lop, date, trangThai }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!["binh_thuong", "huy", "hoc_bu"].includes(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
  const { buoiHocId } = await findOrCreateBuoiHoc(t, { lop, date });
  await ghl(t, "PUT", `/objects/${BUOI_HOC_KEY}/records/${buoiHocId}?locationId=${t.LOC}`, { properties: { trang_thai: trangThai } });
  return { id: buoiHocId, trang_thai: trangThai };
}

// Tạo 1 Học viên hoàn toàn mới trên GHL (chưa nối Contact phụ huynh — đồng bộ CRM phụ huynh vẫn cần làm tay
// nếu cần). Object mới hoàn toàn do chính app tạo nên không cần allowlist theo id — nhưng vẫn thêm ngay vào
// ALLOWED_HOC_VIEN sau khi tạo để ghi danh theo sau (cùng 1 request) dùng được ngay.
export async function createHocVien(locationId, { name, ngaySinh, coSo }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!name || !name.trim()) throw new Error("Cần tên học viên");
  const props = { name: name.trim(), trang_thai: "dang_hoc" };
  if (ngaySinh) props.ngay_sinh = ngaySinh;
  if (coSo) props.co_so = coSo;
  const rec = await ghl(t, "POST", `/objects/${HOC_VIEN_KEY}/records`, { locationId: t.LOC, properties: props });
  const hocVienId = rec.record.id;
  t.ALLOWED_HOC_VIEN.add(hocVienId);
  return { hocVienId };
}

// Xếp lớp / ghi danh: tạo 1 Ghi danh thật và nối vào Học viên + Lớp.
export async function enrollStudent(locationId, { hocVienId, studentName, lop, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!t.ALLOWED_HOC_VIEN.has(hocVienId)) throw new Error(`Chặn: ${hocVienId} không nằm trong danh sách Học viên test được phép`);
  const lopId = t.ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const name = `GD ${studentName} - ${lop}`;
  const props = { name, ngay_bat_dau: ngayBatDau, trang_thai: "dang_hoc", so_buoi_da_hoc: 0 };
  if (ngayHetHan) props.ngay_het_han = ngayHetHan;
  if (tongSoBuoi) props.tong_so_buoi = tongSoBuoi;
  if (tienGiaoCu) props.tien_giao_cu = tienGiaoCu;
  if (hocPhi) props.ghi_chu = `Học phí: ${Number(hocPhi).toLocaleString("vi-VN")} đ (nhập qua app, chưa qua ô tiền tệ chuẩn)`;
  const rec = await ghl(t, "POST", `/objects/${GHI_DANH_KEY}/records`, { locationId: t.LOC, properties: props });
  const ghiDanhId = rec.record.id;
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: ASSOC_HOCVIEN_GHIDANH, firstRecordId: ghiDanhId, secondRecordId: hocVienId });
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: ASSOC_LOP_GHIDANH, firstRecordId: ghiDanhId, secondRecordId: lopId });
  // ALLOWED_GHI_DANH nạp 1 lần lúc getTenantState() đầu tiên — thêm ngay ở đây để ghi danh vừa tạo dùng được
  // NGAY LẬP TỨC (điểm danh/gia hạn) trong CÙNG phiên chạy, không cần đợi cache tenant bị dọn/nạp lại.
  t.ALLOWED_GHI_DANH.add(ghiDanhId);
  return { ghiDanhId, lopId, name };
}

const ALLOWED_GD_TRANG_THAI = new Set(["dang_hoc", "tam_nghi", "da_chuyen_lop", "hoan_thanh", "da_nghi"]);

export async function setGhiDanhTrangThai(locationId, { ghiDanhId, trangThai }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!t.ALLOWED_GHI_DANH.has(ghiDanhId)) throw new Error(`Chặn: ${ghiDanhId} không nằm trong danh sách Ghi danh test được phép`);
  if (!ALLOWED_GD_TRANG_THAI.has(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
  await ghl(t, "PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`, { properties: { trang_thai: trangThai } });
  return { ghiDanhId, trang_thai: trangThai };
}

const LOP_KEY = "custom_objects.lop";

export async function setLichHoc(locationId, { lop, cacThuHoc, gioBatDau, gioKetThuc }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const lopId = t.ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const props = { cac_thu_hoc: (cacThuHoc || []).join(","), gio_bat_dau: gioBatDau || "", gio_ket_thuc: gioKetThuc || "" };
  await ghl(t, "PUT", `/objects/${LOP_KEY}/records/${lopId}?locationId=${t.LOC}`, { properties: props });
  return { lopId, ...props };
}

// Giáo viên: object hoàn toàn mới trên GHL — mọi bản ghi đều do chính app tạo ra, không cần allowlist theo id.
export async function createGiaoVien(locationId, { name, phone, email, ghiChu }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!name || !name.trim()) throw new Error("Cần tên giáo viên");
  const props = { name: name.trim(), trang_thai: "dang_day" };
  if (phone) props.so_dien_thoai = phone;
  if (email) props.email = email;
  if (ghiChu) props.ghi_chu = ghiChu;
  const rec = await ghl(t, "POST", `/objects/${GIAO_VIEN_KEY}/records`, { locationId: t.LOC, properties: props });
  return { id: rec.record.id };
}

export async function updateGiaoVien(locationId, { giaoVienId, name, phone, email, trangThai, ghiChu }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const props = {};
  if (name !== undefined) props.name = name;
  if (phone !== undefined) props.so_dien_thoai = phone;
  if (email !== undefined) props.email = email;
  if (trangThai !== undefined) {
    if (!["dang_day", "tam_nghi", "da_nghi"].includes(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
    props.trang_thai = trangThai;
  }
  if (ghiChu !== undefined) props.ghi_chu = ghiChu;
  if (!Object.keys(props).length) throw new Error("Không có gì để cập nhật");
  await ghl(t, "PUT", `/objects/${GIAO_VIEN_KEY}/records/${giaoVienId}?locationId=${t.LOC}`, { properties: props });
  return { giaoVienId, ...props };
}

// Gán GV cho lớp: xoá quan hệ Lớp↔Giáo viên CŨ của lớp đó trước khi tạo quan hệ mới, giữ đúng mô hình
// "1 lớp 1 GV chính".
export async function ganGiaoVienChoLop(locationId, { giaoVienId, lop }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const lopId = t.ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  try {
    const existing = await ghl(t, "GET", `/associations/relations/${lopId}?locationId=${t.LOC}`);
    const olds = (existing.relations || []).filter((r) => r.associationId === ASSOC_LOP_GIAOVIEN);
    for (const rel of olds) {
      try { await ghl(t, "DELETE", `/associations/relations/${rel.id}?locationId=${t.LOC}`); } catch { /* best-effort */ }
    }
  } catch { /* không đọc được quan hệ cũ — vẫn tiếp tục gán quan hệ mới */ }
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: ASSOC_LOP_GIAOVIEN, firstRecordId: giaoVienId, secondRecordId: lopId });
  return { giaoVienId, lop };
}

// Gia hạn: PATCH thẳng ngày hết hạn / tổng số buổi trên Ghi danh đã có.
export async function renewEnrollment(locationId, { ghiDanhId, ngayHetHanMoi, tongSoBuoiMoi }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!t.ALLOWED_GHI_DANH.has(ghiDanhId)) throw new Error(`Chặn: ${ghiDanhId} không nằm trong danh sách Ghi danh test được phép`);
  const props = {};
  if (ngayHetHanMoi) props.ngay_het_han = ngayHetHanMoi;
  if (tongSoBuoiMoi) props.tong_so_buoi = tongSoBuoiMoi;
  if (!Object.keys(props).length) throw new Error("Cần ít nhất ngày hết hạn mới hoặc tổng số buổi mới");
  await ghl(t, "PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`, { properties: props });
  return { ghiDanhId, ...props };
}

const ATTENDED_STATUSES = new Set(["co_mat", "den_muon"]);

async function bumpSoBuoiDaHoc(t, ghiDanhId) {
  const cur = await ghl(t, "GET", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`);
  const now = Number(cur.record?.properties?.so_buoi_da_hoc) || 0;
  const next = now + 1;
  await ghl(t, "PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`, { properties: { so_buoi_da_hoc: next } });
  return next;
}

// Create ONE real Điểm danh record for a student's session, link it to their Ghi danh AND to the
// Buổi học (session) it belongs to.
export async function writeAttendance(locationId, { studentName, ghiDanhId, lop, date, status, note }) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!t.ALLOWED_GHI_DANH.has(ghiDanhId)) throw new Error(`Chặn: ${ghiDanhId} không nằm trong danh sách Ghi danh test được phép`);
  const { buoiHocId } = await findOrCreateBuoiHoc(t, { lop, date });
  const name = `ĐD ${studentName} ${date}`;
  const props = { name, ngay: date, trang_thai: status };
  if (note) props.ghi_chu = note;
  const rec = await ghl(t, "POST", `/objects/${DIEM_DANH_KEY}/records`, { locationId: t.LOC, properties: props });
  const diemDanhId = rec.record.id;
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: ASSOC_GHIDANH_DIEMDANH, firstRecordId: diemDanhId, secondRecordId: ghiDanhId });
  await ghl(t, "POST", `/associations/relations`, { locationId: t.LOC, associationId: ASSOC_BUOIHOC_DIEMDANH, firstRecordId: buoiHocId, secondRecordId: diemDanhId });
  let soBuoiDaHoc;
  if (ATTENDED_STATUSES.has(status)) {
    try { soBuoiDaHoc = await bumpSoBuoiDaHoc(t, ghiDanhId); }
    catch (e) { console.error(`Cộng dồn so_buoi_da_hoc thất bại cho ${ghiDanhId}:`, e.message); }
  }
  return { diemDanhId, buoiHocId, name, status: STATUS_LABEL[status] || status, soBuoiDaHoc };
}

// Backfill một lần cho các Ghi danh đã có điểm danh thật TRƯỚC KHI bug cộng dồn trên được sửa.
export async function backfillSoBuoiDaHoc(locationId, ghiDanhIds) {
  const t = await getTenantState(locationId);
  if (!t.PIT) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const results = [];
  for (const ghiDanhId of ghiDanhIds) {
    if (!t.ALLOWED_GHI_DANH.has(ghiDanhId)) { results.push({ ghiDanhId, error: "không nằm trong allowlist" }); continue; }
    const rel = await ghl(t, "GET", `/associations/relations/${ghiDanhId}?locationId=${t.LOC}`);
    const diemDanhIds = (rel.relations || [])
      .filter((r) => r.associationId === ASSOC_GHIDANH_DIEMDANH)
      .map((r) => (r.firstRecordId === ghiDanhId ? r.secondRecordId : r.firstRecordId));
    let attended = 0;
    for (const id of diemDanhIds) {
      const rec = await ghl(t, "GET", `/objects/${DIEM_DANH_KEY}/records/${id}?locationId=${t.LOC}`);
      if (ATTENDED_STATUSES.has(rec.record?.properties?.trang_thai)) attended++;
    }
    const cur = await ghl(t, "GET", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`);
    const before = Number(cur.record?.properties?.so_buoi_da_hoc) || 0;
    if (before !== attended) {
      await ghl(t, "PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${t.LOC}`, { properties: { so_buoi_da_hoc: attended } });
    }
    results.push({ ghiDanhId, total_diem_danh: diemDanhIds.length, attended, before, changed: before !== attended });
  }
  return results;
}
