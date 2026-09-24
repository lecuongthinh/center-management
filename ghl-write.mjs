// Guarded writer for the Điểm danh (attendance) demo. Unlike ghl-readonly.mjs, this DOES write to GHL —
// but only into the Điểm danh object, only relating to the known set of test Ghi danh ids (the 18 tagged
// test_object_hoc_vien students), never anywhere else. Token comes from .env (gitignored), never printed/logged.
import fs from "fs";
import { kvGet } from "./db.mjs";
const ENV_PATH = new URL("./.env", import.meta.url);
// process.env ghi đè file .env — trên Render (hay host khác) không có file .env, chỉ có biến set qua
// dashboard nạp vào process.env; ưu tiên process.env thì cục bộ lẫn deploy thật đều đọc đúng.
const env = {
  ...(fs.existsSync(ENV_PATH)
    ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
    : {}),
  ...process.env,
};
const PIT = env.GHL_PIT;
const LOC = env.GHL_LOCATION_ID; // location riêng của từng khách — đổi trong .env, không sửa code
const BASE = "https://services.leadconnectorhq.com";
const H = () => ({ Authorization: `Bearer ${PIT}`, Version: "2021-07-28", "Content-Type": "application/json", Accept: "application/json" });

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

// Allowlist: the only Ghi danh ids this writer will ever attach a Điểm danh record to (the 18 tagged test
// students) OR relate/renew (any Ghi danh created later through the app's own "Ghi danh" flow — tracked in
// the enrollment overlay), and the only Lớp ids it will create/relate Buổi học records for (same test set).
// Reading the overlay here (not just the base snapshot) closes a gap noted earlier: without this, a
// student enrolled via the app could never have attendance marked or their enrollment renewed afterward.
// Cả 2 nguồn giờ đọc từ Postgres (kv_store, xem db.mjs) — trước đây đọc trực tiếp file JSON cục bộ, độc
// lập hoàn toàn với state của server.mjs (đã chuyển sang Postgres) và sẽ crash lúc khởi động trên Render
// (file không tồn tại, bị .gitignore). Đọc CÙNG 1 nguồn với server.mjs thì allowlist cũng luôn khớp thực tế.
const candy = await kvGet("base_snapshot", { students: [], classes: [], attendance_seed: [] });
const enrollOverlay = await kvGet("enrollment_overlay", []);
const allKnownStudents = [...candy.students, ...enrollOverlay];
const ALLOWED_GHI_DANH = new Set(allKnownStudents.map((s) => s.ghi_danh_id));
const ALLOWED_LOP = new Map(candy.classes.map((c) => [c.lop, c.lop_id]));
const ALLOWED_HOC_VIEN = new Set(allKnownStudents.map((s) => s.hoc_vien_id));
const STATUS_LABEL = { co_mat: "Có mặt", vang_co_phep: "Vắng có phép", vang_khong_phep: "Vắng không phép", den_muon: "Đến muộn" };

export const writerEnabled = () => Boolean(PIT);

async function ghl(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`GHL ${method} ${path.replace(/\/records\/[^/]+/, "/records/<id>")} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

// Buổi học = 1 real session of 1 Lớp on 1 date. Find-or-create so marking attendance twice for the
// same lớp+ngày never creates a duplicate session record — the search is the idempotency check. Also
// tracks `created` (new vs already existed) so bulk callers (sinh lịch trước) can report a real count,
// not just "done".
const buoiHocCache = new Map(); // `${lop}|${date}` -> {buoiHocId, created}, avoids a search call per student in the same batch
export async function findOrCreateBuoiHoc({ lop, date }) {
  const lopId = ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const cacheKey = `${lop}|${date}`;
  if (buoiHocCache.has(cacheKey)) return buoiHocCache.get(cacheKey);
  const name = `Buổi ${lop} ${date}`;
  const search = await ghl("POST", `/objects/${BUOI_HOC_KEY}/records/search`, { locationId: LOC, page: 1, pageLimit: 5, query: name });
  const found = (search.records || []).find((r) => r.properties?.name === name);
  let buoiHocId, created;
  if (found) {
    buoiHocId = found.id; created = false;
  } else {
    const rec = await ghl("POST", `/objects/${BUOI_HOC_KEY}/records`, { locationId: LOC, properties: { name, ngay: date, trang_thai: "binh_thuong" } });
    buoiHocId = rec.record.id; created = true;
    await ghl("POST", `/associations/relations`, { locationId: LOC, associationId: ASSOC_LOP_BUOIHOC, firstRecordId: buoiHocId, secondRecordId: lopId });
  }
  const result = { buoiHocId, created };
  buoiHocCache.set(cacheKey, result);
  return result;
}

// Sinh lịch buổi học trước (Đợt "quản lý lớp còn thiếu gì" #3): tạo trước Buổi học cho 1 loạt ngày sắp
// tới thay vì chỉ tạo phản ứng lúc điểm danh — để staff thấy/huỷ/xếp GV dạy thay TRƯỚC ngày học diễn ra.
// Tái dùng đúng cơ chế find-or-create đã có nên gọi lại nhiều lần (vd 2 lớp trùng 1 ngày) vẫn an toàn.
export async function generateSessions({ lop, dates }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const results = [];
  for (const date of dates) {
    const { buoiHocId, created } = await findOrCreateBuoiHoc({ lop, date });
    results.push({ date, buoiHocId, created });
  }
  return results;
}

// Đồng bộ CRM: mỗi Học viên đã được nối với 1 Contact (phụ huynh) thật từ lúc build object model
// (association contact_hoc_vien) — chưa từng hiện ra UI cho tới giờ. Read-only, no side effects.
export async function getPhuHuynh({ hocVienId }) {
  if (!ALLOWED_HOC_VIEN.has(hocVienId)) throw new Error(`Chặn: ${hocVienId} không nằm trong danh sách Học viên test được phép`);
  const rel = await ghl("GET", `/associations/relations/${hocVienId}?locationId=${LOC}`);
  const contactRel = (rel.relations || []).find((r) => r.firstObjectKey === "contact");
  if (!contactRel) return null;
  const c = await ghl("GET", `/contacts/${contactRel.firstRecordId}`);
  const contact = c.contact;
  if (!contact) return null;
  return { id: contact.id, name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(), phone: contact.phone || "", email: contact.email || "", tags: contact.tags || [] };
}

// Read-only lookup (no create) — for showing "Buổi học" state in the UI without side effects.
export async function getBuoiHoc({ lop, date }) {
  if (!ALLOWED_LOP.has(lop)) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const name = `Buổi ${lop} ${date}`;
  const search = await ghl("POST", `/objects/${BUOI_HOC_KEY}/records/search`, { locationId: LOC, page: 1, pageLimit: 5, query: name });
  const found = (search.records || []).find((r) => r.properties?.name === name);
  if (!found) return null;
  return { id: found.id, ngay: found.properties?.ngay, trang_thai: found.properties?.trang_thai, giao_vien_day: found.properties?.giao_vien_day || "" };
}

// Danh sách Buổi học của 1 lớp (Đợt "quản lý lớp còn thiếu gì" — màn xem theo lô sau "sinh lịch trước").
// query bằng tên lớp rồi lọc lại bằng prefix chính xác — không tin search của GHL khớp đúng 100% ký tự,
// nhất là tên lớp có dấu tiếng Việt.
export async function listBuoiHoc({ lop }) {
  if (!ALLOWED_LOP.has(lop)) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const prefix = `Buổi ${lop} `;
  const search = await ghl("POST", `/objects/${BUOI_HOC_KEY}/records/search`, { locationId: LOC, page: 1, pageLimit: 100, query: lop });
  return (search.records || [])
    .filter((r) => (r.properties?.name || "").startsWith(prefix))
    .map((r) => ({ id: r.id, ngay: r.properties?.ngay || "", trang_thai: r.properties?.trang_thai || "binh_thuong", giao_vien_day: r.properties?.giao_vien_day || "" }))
    .sort((a, b) => a.ngay.localeCompare(b.ngay));
}

// Cập nhật trực tiếp 1 Buổi học đã biết ID (từ danh sách trên) — trạng thái và/hoặc GV dạy thay (trước
// giờ field này có trên schema từ lúc build ban đầu nhưng chưa từng có chỗ để set, y hệt lỗi "field chết"
// đã gặp ở trạng thái Ghi danh). Không cần allowlist theo buoiHocId riêng vì id luôn đến từ listBuoiHoc()
// (đã tự giới hạn theo lop hợp lệ) — app này chỉ 1 người dùng cục bộ, không đối mặt truy cập từ bên ngoài.
export async function updateBuoiHoc({ buoiHocId, trangThai, giaoVienDay }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const props = {};
  if (trangThai) {
    if (!["binh_thuong", "huy", "hoc_bu"].includes(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
    props.trang_thai = trangThai;
  }
  if (giaoVienDay !== undefined) props.giao_vien_day = giaoVienDay;
  if (!Object.keys(props).length) throw new Error("Không có gì để cập nhật");
  await ghl("PUT", `/objects/${BUOI_HOC_KEY}/records/${buoiHocId}?locationId=${LOC}`, { properties: props });
  return { buoiHocId, ...props };
}

// Học bù (Đợt 4): đổi trạng thái 1 Buổi học đã có/mới tạo — "hủy" hoặc "hoc_bu" là hành động thật
// trên GHL, không phải chỉ đổi ở UI cục bộ, vì trạng thái này là thứ mọi người (kể cả admin xem trên
// GHL trực tiếp) cần thấy đúng, không riêng gì app demo này.
export async function setBuoiHocTrangThai({ lop, date, trangThai }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!["binh_thuong", "huy", "hoc_bu"].includes(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
  const { buoiHocId } = await findOrCreateBuoiHoc({ lop, date });
  await ghl("PUT", `/objects/${BUOI_HOC_KEY}/records/${buoiHocId}?locationId=${LOC}`, { properties: { trang_thai: trangThai } });
  return { id: buoiHocId, trang_thai: trangThai };
}

// Xếp lớp / ghi danh (Đợt "quản lý lớp còn thiếu gì"): tạo 1 Ghi danh thật và nối vào Học viên + Lớp.
// Chặn ở 2 lớp: hocVienId phải nằm trong 18 học viên test (không ghi danh hộ người ngoài danh sách),
// lop phải là 1 trong 30 lớp thật đã biết trên GHL (không tạo lớp lạ). Kiểm tra sĩ số tối đa là việc của
// caller (server.mjs) vì cần cộng cả overlay — hàm này chỉ lo phần ghi thật + validate an toàn.
// hoc_phi dùng field MONETORY đang lỗi (không nhận VND) nên theo đúng workaround đã dùng cho 18 hs cũ:
// ghi số tiền vào ghi_chu dạng text, không đụng vào field hoc_phi.
export async function enrollStudent({ hocVienId, studentName, lop, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!ALLOWED_HOC_VIEN.has(hocVienId)) throw new Error(`Chặn: ${hocVienId} không nằm trong danh sách Học viên test được phép`);
  const lopId = ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const name = `GD ${studentName} - ${lop}`;
  const props = { name, ngay_bat_dau: ngayBatDau, trang_thai: "dang_hoc", so_buoi_da_hoc: 0 };
  if (ngayHetHan) props.ngay_het_han = ngayHetHan;
  if (tongSoBuoi) props.tong_so_buoi = tongSoBuoi;
  if (tienGiaoCu) props.tien_giao_cu = tienGiaoCu;
  if (hocPhi) props.ghi_chu = `Học phí: ${Number(hocPhi).toLocaleString("vi-VN")} đ (nhập qua app, chưa qua ô tiền tệ chuẩn)`;
  const rec = await ghl("POST", `/objects/${GHI_DANH_KEY}/records`, { locationId: LOC, properties: props });
  const ghiDanhId = rec.record.id;
  await ghl("POST", `/associations/relations`, { locationId: LOC, associationId: ASSOC_HOCVIEN_GHIDANH, firstRecordId: ghiDanhId, secondRecordId: hocVienId });
  await ghl("POST", `/associations/relations`, { locationId: LOC, associationId: ASSOC_LOP_GHIDANH, firstRecordId: ghiDanhId, secondRecordId: lopId });
  return { ghiDanhId, lopId, name };
}

const LOP_KEY = "custom_objects.lop";
const ALLOWED_GD_TRANG_THAI = new Set(["dang_hoc", "tam_nghi", "da_chuyen_lop", "hoan_thanh", "da_nghi"]);

// Đóng vòng đời ghi danh (Đợt "quản lý lớp còn thiếu gì"): 5 trạng thái đã có sẵn trong schema Ghi danh
// từ lúc build ban đầu nhưng chưa từng có đường ghi — staff không thể đổi Đang học → Tạm nghỉ/Hoàn thành/
// Đã nghỉ qua bất kỳ đâu. "da_chuyen_lop" cố tình KHÔNG cho set trực tiếp qua đây (chỉ set như tác dụng
// phụ của chuyển lớp thật, xem server.mjs `/api/candy/chuyen-lop`) vì tự set mà không có Ghi danh mới đi
// kèm sẽ để lại thông tin sai lệch (nói "đã chuyển lớp" nhưng không biết chuyển đi đâu).
export async function setGhiDanhTrangThai({ ghiDanhId, trangThai }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!ALLOWED_GHI_DANH.has(ghiDanhId)) throw new Error(`Chặn: ${ghiDanhId} không nằm trong danh sách Ghi danh test được phép`);
  if (!ALLOWED_GD_TRANG_THAI.has(trangThai)) throw new Error(`Trạng thái không hợp lệ: ${trangThai}`);
  await ghl("PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${LOC}`, { properties: { trang_thai: trangThai } });
  return { ghiDanhId, trang_thai: trangThai };
}

// Thời khoá biểu (Đợt "quản lý lớp còn thiếu gì" #2): thay ô "lịch học" tự do bằng dữ liệu có cấu trúc
// (các thứ trong tuần + giờ bắt đầu/kết thúc) — đúng chuẩn Teachworks/Glofox (chọn thứ + khung giờ, không
// gõ tay). Kiểm tra trùng lịch dạy của giáo viên là việc của server.mjs (đọc allClasses() trước khi gọi
// hàm này) — hàm này chỉ lo phần ghi thật + validate lớp có trong allowlist.
export async function setLichHoc({ lop, cacThuHoc, gioBatDau, gioKetThuc }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const lopId = ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  const props = { cac_thu_hoc: (cacThuHoc || []).join(","), gio_bat_dau: gioBatDau || "", gio_ket_thuc: gioKetThuc || "" };
  await ghl("PUT", `/objects/${LOP_KEY}/records/${lopId}?locationId=${LOC}`, { properties: props });
  return { lopId, ...props };
}

// Giáo viên (Đợt "phân giáo viên, quản lý giáo viên"): object thật thứ 6/10, thay cho field `giao_vien`
// tự do trên Lớp — field đó CHƯA TỪNG có UI để set trong suốt các đợt trước ("field chết" thứ 3 phát hiện
// trong phiên này), dù chính nó đứng sau logic chặn trùng lịch dạy đã xây. Không cần allowlist theo id vì
// object này hoàn toàn mới — mọi bản ghi đều do chính app tạo ra, không có dữ liệu thật có sẵn để lỡ đụng vào.
export async function createGiaoVien({ name, phone, email, ghiChu }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!name || !name.trim()) throw new Error("Cần tên giáo viên");
  const props = { name: name.trim(), trang_thai: "dang_day" };
  if (phone) props.so_dien_thoai = phone;
  if (email) props.email = email;
  if (ghiChu) props.ghi_chu = ghiChu;
  const rec = await ghl("POST", `/objects/${GIAO_VIEN_KEY}/records`, { locationId: LOC, properties: props });
  return { id: rec.record.id };
}

export async function updateGiaoVien({ giaoVienId, name, phone, email, trangThai, ghiChu }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
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
  await ghl("PUT", `/objects/${GIAO_VIEN_KEY}/records/${giaoVienId}?locationId=${LOC}`, { properties: props });
  return { giaoVienId, ...props };
}

// Gán GV cho lớp: xoá quan hệ Lớp↔Giáo viên CŨ của lớp đó trước khi tạo quan hệ mới, giữ đúng mô hình
// "1 lớp 1 GV chính" (khớp cách field tự do cũ hoạt động — 1 chuỗi, không phải danh sách). API xoá 1
// relation instance của GHL không có trong tài liệu đã ghi nhận — thử trực tiếp; nếu GHL không hỗ trợ,
// bắt lỗi và bỏ qua bước xoá thay vì làm hỏng luôn thao tác gán chính.
export async function ganGiaoVienChoLop({ giaoVienId, lop }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const lopId = ALLOWED_LOP.get(lop);
  if (!lopId) throw new Error(`Chặn: ${lop} không nằm trong danh sách Lớp test được phép`);
  try {
    const existing = await ghl("GET", `/associations/relations/${lopId}?locationId=${LOC}`);
    const olds = (existing.relations || []).filter((r) => r.associationId === ASSOC_LOP_GIAOVIEN);
    for (const rel of olds) {
      // Xác nhận thật: DELETE relation instance CẦN locationId trên query string (ngược với DELETE record,
      // vốn từ chối locationId) — thiếu nó sẽ luôn 400 và im lặng bỏ qua nếu không có try/catch bọc ngoài.
      try { await ghl("DELETE", `/associations/relations/${rel.id}?locationId=${LOC}`); } catch { /* best-effort — không chặn thao tác gán chính nếu xoá quan hệ cũ lỡ lỗi */ }
    }
  } catch { /* không đọc được quan hệ cũ — vẫn tiếp tục gán quan hệ mới */ }
  await ghl("POST", `/associations/relations`, { locationId: LOC, associationId: ASSOC_LOP_GIAOVIEN, firstRecordId: giaoVienId, secondRecordId: lopId });
  return { giaoVienId, lop };
}

// Gia hạn (Đợt "quản lý lớp còn thiếu gì" #7): PATCH thẳng ngày hết hạn / tổng số buổi trên Ghi danh đã
// có — không tạo bản ghi mới (khác với "chuyển lớp", vốn cần 1 Ghi danh mới ở lớp khác). Đây là hành động
// staff làm trực tiếp từ cảnh báo "sắp hết hạn", nên chỉ cho phép trên Ghi danh đã biết (allowlist).
export async function renewEnrollment({ ghiDanhId, ngayHetHanMoi, tongSoBuoiMoi }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!ALLOWED_GHI_DANH.has(ghiDanhId)) throw new Error(`Chặn: ${ghiDanhId} không nằm trong danh sách Ghi danh test được phép`);
  const props = {};
  if (ngayHetHanMoi) props.ngay_het_han = ngayHetHanMoi;
  if (tongSoBuoiMoi) props.tong_so_buoi = tongSoBuoiMoi;
  if (!Object.keys(props).length) throw new Error("Cần ít nhất ngày hết hạn mới hoặc tổng số buổi mới");
  await ghl("PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${LOC}`, { properties: props });
  return { ghiDanhId, ...props };
}

// "Có mặt"/"Đến muộn" = thật sự có tham dự 1 buổi (kể cả buổi học bù thay cho 1 buổi vắng) nên tính vào
// tổng số buổi đã học; 2 trạng thái vắng thì không. Dùng chung cho ghi điểm danh mới lẫn backfill bên dưới.
const ATTENDED_STATUSES = new Set(["co_mat", "den_muon"]);

async function bumpSoBuoiDaHoc(ghiDanhId) {
  const cur = await ghl("GET", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${LOC}`);
  const now = Number(cur.record?.properties?.so_buoi_da_hoc) || 0;
  const next = now + 1;
  await ghl("PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${LOC}`, { properties: { so_buoi_da_hoc: next } });
  return next;
}

// Create ONE real Điểm danh record for a student's session, link it to their Ghi danh AND to the
// Buổi học (session) it belongs to — so 1 buổi có thể hủy/đổi trạng thái mà không phải sửa từng điểm danh.
// Throws if ghiDanhId isn't in the allowlist — this is the actual safety boundary, not just UI intent.
export async function writeAttendance({ studentName, ghiDanhId, lop, date, status, note }) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  if (!ALLOWED_GHI_DANH.has(ghiDanhId)) throw new Error(`Chặn: ${ghiDanhId} không nằm trong danh sách Ghi danh test được phép`);
  const { buoiHocId } = await findOrCreateBuoiHoc({ lop, date });
  const name = `ĐD ${studentName} ${date}`;
  const props = { name, ngay: date, trang_thai: status };
  if (note) props.ghi_chu = note;
  const rec = await ghl("POST", `/objects/${DIEM_DANH_KEY}/records`, { locationId: LOC, properties: props });
  const diemDanhId = rec.record.id;
  await ghl("POST", `/associations/relations`, { locationId: LOC, associationId: ASSOC_GHIDANH_DIEMDANH, firstRecordId: diemDanhId, secondRecordId: ghiDanhId });
  await ghl("POST", `/associations/relations`, { locationId: LOC, associationId: ASSOC_BUOIHOC_DIEMDANH, firstRecordId: buoiHocId, secondRecordId: diemDanhId });
  // Bug "field chết" mới phát hiện: trước đây không có bước nào cộng dồn so_buoi_da_hoc trên Ghi danh khi
  // điểm danh Có mặt/Đến muộn — cột "Đã học/Tổng buổi" hiển thị SAI (luôn 0) trên 3 màn hình dù đã điểm
  // danh thật. Cộng dồn ở đây thay vì tính lại từ đầu mỗi lần đọc — vì attendance route ở server.mjs vốn
  // đã idempotent theo từng ô (không gọi writeAttendance 2 lần cho cùng 1 buổi/học viên), an toàn để +1.
  // Lỗi ở bước cộng dồn không được làm mất bản ghi điểm danh chính đã lưu thành công — chỉ log, không throw.
  let soBuoiDaHoc;
  if (ATTENDED_STATUSES.has(status)) {
    try { soBuoiDaHoc = await bumpSoBuoiDaHoc(ghiDanhId); }
    catch (e) { console.error(`Cộng dồn so_buoi_da_hoc thất bại cho ${ghiDanhId}:`, e.message); }
  }
  return { diemDanhId, buoiHocId, name, status: STATUS_LABEL[status] || status, soBuoiDaHoc };
}

// Backfill một lần cho các Ghi danh đã có điểm danh thật TRƯỚC KHI bug trên được sửa: đếm lại từ chính
// các Điểm danh thật đã quan hệ với Ghi danh đó trên GHL (nguồn sự thật), không suy từ file overlay cục bộ
// (có thể đã lệch sau các lần dọn dẹp) — rồi ghi so_buoi_da_hoc đúng bằng số đếm được. Chỉ ghi khi khác giá
// trị hiện tại, để không tạo thay đổi thừa trên các Ghi danh vốn đã đúng (đa số, vì mới enroll = 0 thật).
export async function backfillSoBuoiDaHoc(ghiDanhIds) {
  if (!writerEnabled()) throw new Error("GHL_PIT không có trong .env — chưa bật ghi thật");
  const results = [];
  for (const ghiDanhId of ghiDanhIds) {
    if (!ALLOWED_GHI_DANH.has(ghiDanhId)) { results.push({ ghiDanhId, error: "không nằm trong allowlist" }); continue; }
    const rel = await ghl("GET", `/associations/relations/${ghiDanhId}?locationId=${LOC}`);
    const diemDanhIds = (rel.relations || [])
      .filter((r) => r.associationId === ASSOC_GHIDANH_DIEMDANH)
      .map((r) => (r.firstRecordId === ghiDanhId ? r.secondRecordId : r.firstRecordId));
    let attended = 0;
    for (const id of diemDanhIds) {
      const rec = await ghl("GET", `/objects/${DIEM_DANH_KEY}/records/${id}?locationId=${LOC}`);
      if (ATTENDED_STATUSES.has(rec.record?.properties?.trang_thai)) attended++;
    }
    const cur = await ghl("GET", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${LOC}`);
    const before = Number(cur.record?.properties?.so_buoi_da_hoc) || 0;
    if (before !== attended) {
      await ghl("PUT", `/objects/${GHI_DANH_KEY}/records/${ghiDanhId}?locationId=${LOC}`, { properties: { so_buoi_da_hoc: attended } });
    }
    results.push({ ghiDanhId, total_diem_danh: diemDanhIds.length, attended, before, changed: before !== attended });
  }
  return results;
}
