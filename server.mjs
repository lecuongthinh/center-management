// Local-only demo server (127.0.0.1). Serves the built app + a "mirror" API backed by data/contacts.json.
// The only outbound call is a GET of one contact's notes for the profile screen (ghl-readonly.mjs has no write function).
import http from "http"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
import { ghlGet } from "./ghl-readonly.mjs";
import { writeAttendance, writerEnabled, getBuoiHoc, setBuoiHocTrangThai, getPhuHuynh, enrollStudent, renewEnrollment, setLichHoc, setGhiDanhTrangThai, generateSessions, listBuoiHoc, updateBuoiHoc, createGiaoVien, updateGiaoVien, ganGiaoVienChoLop } from "./ghl-write.mjs";
import { findStaff, listStaff, addStaff, setStaffRole, removeStaff, createSession, getSession, destroySession, getCmlKey, decryptGhlUserData } from "./auth.mjs";
import { kvGet, kvSet } from "./db.mjs";
const DELAY = Number(process.env.MIRROR_DELAY_MS ?? 140); // simulates a remote Supabase round-trip (measured ~140 ms)
// Module "Khách hàng" (demo 123 GYM, dữ liệu thật của 1 khách KHÁC hẳn Candy English) — cố tình KHÔNG deploy
// lên bản thật của Candy English (data/ bị .gitignore hoàn toàn, không đưa PII lên git). File này chỉ tồn
// tại trên máy cục bộ; thiếu thì tự tắt module này thay vì làm sập cả server lúc khởi động.
const contactsPath = new URL("./data/contacts.json", import.meta.url);
const contactsEnabled = fs.existsSync(contactsPath);
const all = contactsEnabled ? JSON.parse(fs.readFileSync(contactsPath, "utf8")).contacts : [];
const overlay = new Map(); // local-only edits, never sent to GHL

// Candy English attendance demo: real test objects (Học viên/Lớp/Ghi danh/Điểm danh) created
// earlier this session on location PFP2DrRKSpK18zwXbQVq, all tagged test_object_hoc_vien.
// Attendance marked in THIS demo is local-only (overlay) unless explicitly pushed to GHL by Claude on request.
// Ảnh chụp gốc lúc migrate (candy_attendance.json) cũng có PII thật — đã chuyển vào Postgres (key
// "base_snapshot") cùng chỗ với các overlay khác, không còn đọc từ file cục bộ nữa.
const candy = await kvGet("base_snapshot", { students: [], classes: [], attendance_seed: [] });
// --- Trạng thái vận hành (overlay/cấu hình lớp học) — CHUYỂN sang Postgres (bảng kv_store, schema
// candy_english), KHÔNG còn là file JSON cục bộ nữa: ổ đĩa của Render không bền, file cục bộ mất sạch mỗi
// lần redeploy. Bộ nhớ trong tiến trình (biến JS bên dưới) vẫn là nguồn đọc chính — luôn đồng bộ, không
// đổi cách đọc ở bất kỳ đâu khác trong file này; save*() giờ ghi nền (fire-and-forget) xuống Postgres thay
// vì writeFileSync đồng bộ — đủ an toàn cho 1 app vận hành nội bộ, ít người dùng đồng thời.
// candy_attendance.json (ảnh chụp gốc lúc migrate, hiếm khi đổi) vẫn ở dạng file — chưa cần chuyển.
const onSaveErr = (label) => (e) => console.error(`Lưu ${label} vào Postgres thất bại:`, e.message);
let attOverlay = await kvGet("attendance_overlay", {}); // key: `${lop}|${date}` -> {studentN: {status, note}}
const saveAttOverlay = () => kvSet("attendance_overlay", attOverlay).catch(onSaveErr("attendance_overlay"));

// Xếp lớp (Đợt "quản lý lớp còn thiếu gì"): Ghi danh MỚI tạo qua app đi vào đây, KHÔNG sửa thẳng
// candy_attendance.json (file đó là ảnh chụp gốc từ đợt migrate/backfill). allStudents()/allClasses()
// gộp base + overlay tại chỗ đọc, nên mọi route hiện có tự thấy học viên mới mà không cần sửa logic riêng.
let enrollOverlay = await kvGet("enrollment_overlay", []);
const saveEnrollOverlay = () => kvSet("enrollment_overlay", enrollOverlay).catch(onSaveErr("enrollment_overlay"));
const nextEnrollN = () => 1000 + enrollOverlay.length;

// Gia hạn (Đợt "quản lý lớp còn thiếu gì" #7): PATCH ngay_het_han/tong_so_buoi trên 1 Ghi danh ĐÃ CÓ —
// áp dụng lên cả bản ghi gốc (candy.students, chỉ đọc — không sửa thẳng file migrate) lẫn bản ghi mới
// (enrollOverlay) qua 1 bảng override chung, khoá theo ghi_danh_id, đọc chồng lên lúc gộp allStudents().
let ghOverrides = await kvGet("ghidanh_overrides", {}); // ghi_danh_id -> {ngay_het_han?, sessions_total?}
const saveGhOverrides = () => kvSet("ghidanh_overrides", ghOverrides).catch(onSaveErr("ghidanh_overrides"));
const applyOverride = (s) => (ghOverrides[s.ghi_danh_id] ? { ...s, ...ghOverrides[s.ghi_danh_id] } : s);
const allStudents = () => [...candy.students, ...enrollOverlay].map(applyOverride);

// Thời khoá biểu (Đợt "quản lý lớp còn thiếu gì" #2): cac_thu_hoc/gio_bat_dau/gio_ket_thuc là field MỚI
// trên GHL (trống trên cả 30 lớp thật cho tới khi staff nhập) — override khoá theo TÊN lớp, áp lên
// allClasses() giống hệt cách ghOverrides áp lên allStudents().
let lopOverrides = await kvGet("lop_overrides", {}); // lop name -> {cac_thu_hoc?, gio_bat_dau?, gio_ket_thuc?}
const saveLopOverrides = () => kvSet("lop_overrides", lopOverrides).catch(onSaveErr("lop_overrides"));
const allClasses = () => candy.classes.map((c) => ({
  ...c, ...(lopOverrides[c.lop] || {}),
  students: [...c.students, ...enrollOverlay.filter((e) => e.lop === c.lop).map((e) => e.n)],
}));
// Giáo viên (Đợt "phân giáo viên"): roster cục bộ do chính app tạo ra (object hoàn toàn mới trên GHL,
// không có dữ liệu có sẵn để đồng bộ) — gán GV cho lớp chỉ cần ghi `giao_vien`/`giao_vien_id` vào
// lopOverrides, mọi nơi đã đọc `c.giao_vien` từ trước (bảng lớp, thời khoá biểu, chặn trùng lịch) tự
// thấy giá trị mới mà không cần sửa gì thêm.
let giaoVienList = await kvGet("giao_vien_list", []);
const saveGiaoVien = () => kvSet("giao_vien_list", giaoVienList).catch(onSaveErr("giao_vien_list"));
const THU_LABEL = { T2: "Thứ 2", T3: "Thứ 3", T4: "Thứ 4", T5: "Thứ 5", T6: "Thứ 6", T7: "Thứ 7", CN: "Chủ nhật" };
const THU_ORDER = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
// 2 khung giờ overlap khi start1 < end2 VÀ start2 < end1 (chuẩn kiểm tra chồng lấn khoảng thời gian).
const gioOverlap = (s1, e1, s2, e2) => s1 && e1 && s2 && e2 && s1 < e2 && s2 < e1;
// Dùng chung cho cả 2 hướng có thể gây trùng lịch dạy: (1) sửa lịch học của 1 lớp đã có GV, (2) gán GV cho
// 1 lớp đã có lịch học — thiếu 1 trong 2 hướng thì vẫn gán được 1 GV vào 2 lớp trùng giờ qua đường còn lại.
function findTeacherConflict({ lop, giaoVienTen, cacThuHoc, gioBatDau, gioKetThuc }) {
  const days = typeof cacThuHoc === "string" ? cacThuHoc.split(",").filter(Boolean) : (cacThuHoc || []);
  if (!giaoVienTen || !days.length || !gioBatDau || !gioKetThuc) return null;
  return allClasses().find((c) =>
    c.lop !== lop && c.giao_vien === giaoVienTen &&
    (c.cac_thu_hoc || "").split(",").some((t) => days.includes(t)) &&
    gioOverlap(gioBatDau, gioKetThuc, c.gio_bat_dau, c.gio_ket_thuc));
}
const teacherConflictMsg = (giaoVienTen, cacThuHoc, conflict) => {
  const days = typeof cacThuHoc === "string" ? cacThuHoc.split(",").filter(Boolean) : cacThuHoc;
  return `Trùng lịch: GV ${giaoVienTen} đã dạy lớp ${conflict.lop} vào ${THU_LABEL[days.find((t) => (conflict.cac_thu_hoc || "").split(",").includes(t))] || ""} ${conflict.gio_bat_dau}-${conflict.gio_ket_thuc}`;
};
const JS_DAY_TO_THU = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"]; // Date.getDay(): 0=CN...6=T7
// Server chạy giờ Asia/Saigon (UTC+7) — toISOString() luôn lùi lại 1 ngày (00:00 giờ VN = 17:00 UTC hôm
// TRƯỚC) nên KHÔNG BAO GIỜ dùng nó để lấy chuỗi yyyy-mm-dd theo lịch địa phương. Dùng hàm này thay thế.
const toLocalISODate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Liệt kê mọi ngày (yyyy-mm-dd) trong [fromDate, toDate] mà thứ trong tuần khớp cac_thu_hoc — dùng để
// sinh lịch Buổi học trước, thay vì chỉ tạo phản ứng lúc điểm danh.
function datesForThu(cacThuHocStr, fromDate, toDate) {
  const wanted = new Set((cacThuHocStr || "").split(",").filter(Boolean));
  const dates = [];
  const d = new Date(fromDate + "T00:00:00"), end = new Date(toDate + "T00:00:00");
  while (d <= end) {
    if (wanted.has(JS_DAY_TO_THU[d.getDay()])) dates.push(toLocalISODate(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// Quy tắc học bù (Đợt 4): SỐ BUỔI TỐI ĐA + LOẠI VẮNG ĐƯỢC BÙ do admin chỉnh trong UI (Cấu hình), không
// hardcode trong code — đúng nguyên tắc "quy tắc staff phải theo sống trong UI, không nằm trong trí nhớ ai".
// cung_cap_do (được bù ở lớp khác cùng cấp độ) và han_dung (hạn dùng = ngày hết hạn gói) là quy tắc
// nghiệp vụ đã chốt với chủ trung tâm — cố định trong code, không cho chỉnh qua UI để tránh sai lệch.
const DEFAULT_CONFIG = { hoc_bu: { so_buoi_toi_da: 4, loai_vang_duoc_bu: ["vang_co_phep"], cung_cap_do: true, han_dung: "ngay_het_han" } };
let candyConfig = await kvGet("config", DEFAULT_CONFIG);
const saveConfig = () => kvSet("config", candyConfig).catch(onSaveErr("config"));
const ATT_STATUS = { co_mat: "Có mặt", vang_co_phep: "Vắng có phép", vang_khong_phep: "Vắng không phép", den_muon: "Đến muộn" };

// Đặt lịch học bù thực tế (Đợt "quản lý lớp còn thiếu gì" #8): nối luật đã cấu hình (tab Cấu hình) thành
// 1 thao tác ghi thật — tạo 1 Điểm danh thật tại lớp/ngày bù, nối vào ĐÚNG Ghi danh gốc (học viên không
// ghi danh lớp bù, chỉ mượn 1 buổi), quota dùng/còn lại tính từ overlay này theo từng Ghi danh.
let hocBuOverlay = await kvGet("hocbu_overlay", []);
const saveHocBuOverlay = () => kvSet("hocbu_overlay", hocBuOverlay).catch(onSaveErr("hocbu_overlay"));
const dist = fileURLToPath(new URL("./dist/", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
// Lỗi thật đã có từ trước, bắt được lúc test tính năng tìm học viên mới: thay "đ"→"d" chạy TRƯỚC
// toLowerCase() nên bỏ sót "Đ" viết hoa (Đức, Đặng, Đình...) — tên có "Đ" hoa sẽ còn sót lại "đ" sau khi
// fold, không khớp khi ai đó gõ "duc"/"dang" không dấu. Cờ /gi khớp cả 2 hoa/thường, không cần đổi thứ tự.
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();
const idx = all.map((c) => ({ c, key: fold(c.name) + " " + c.phone.replace(/\D/g, "") }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withOverlay = (c) => (overlay.has(c.id) ? { ...c, tags: [...new Set([...c.tags, ...overlay.get(c.id)])] } : c);
const json = (res, obj, code = 200) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
const num = (v) => Number(String(v ?? "").replace(/[^\d.-]/g, "")) || 0;
// Cấu hình thương hiệu (tên, chữ viết tắt logo, tên đơn vị đầy đủ) tách riêng thành file — để nhân bản
// app này cho khách mới chỉ cần sửa 1 file JSON này, không phải sửa code/tìm-thay-thế rải rác khắp nơi.
// KHÔNG gồm nhãn nghiệp vụ (học viên/lớp/giáo viên...) — đổi loại hình kinh doanh cần thiết kế lại object
// trên GHL, không chỉ đổi chữ, nên để nguyên phần đó cho đợt sau.
const branding = JSON.parse(fs.readFileSync(new URL("./data/branding.json", import.meta.url), "utf8"));
const notLoggedInPage = (msg) => `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${branding.brandName} · Vận hành</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f9;font:15px/1.5 system-ui,-apple-system,sans-serif;color:#161b26">
<div style="max-width:420px;padding:32px;text-align:center">
<div style="width:44px;height:44px;margin:0 auto 16px;border-radius:12px;background:linear-gradient(135deg,#3457e0,#7c5cff);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800">${branding.brandMark}</div>
<h2 style="margin:0 0 8px">Chưa đăng nhập</h2><p style="color:#667085">${msg}</p></div></body></html>`;
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    // Công khai, không cần đăng nhập — màn "Chưa đăng nhập" phía client cũng cần biết tên/logo thương hiệu
    // trước khi biết ai đang xem, nên route này phải đứng trước mọi cổng xác thực bên dưới.
    if (u.pathname === "/api/branding") return json(res, { ...branding, khachHangEnabled: contactsEnabled });
    // Đăng nhập qua GHL Custom Menu Link: khi nhân viên bấm menu trong GHL, URL sẽ có sẵn ?email=...&name=...
    // (GHL tự thay bằng dữ liệu thật của người đang bấm). ĐÃ XÁC NHẬN THỰC TẾ (test 2026-09-24): dù chọn
    // "Open in a New Browser Tab", GHL vẫn mở 1 trang do CHÍNH GHL host (app.<domain>/.../custom-menu-link/…)
    // rồi nhúng app của mình vào BÊN TRONG qua iframe — thanh địa chỉ không bao giờ đổi thành domain thật
    // của app, ở CẢ 2 chế độ. Cookie đặt ra từ bên trong iframe của 1 domain khác (bên thứ ba) bị trình
    // duyệt hiện đại âm thầm chặn/không giữ lại — vì vậy KHÔNG dùng cookie nữa, chuyển hẳn sang token lưu ở
    // localStorage (không bị chính sách cookie chi phối) + header Authorization: Bearer cho mọi gọi API.
    // Hệ quả: index.html/JS/CSS giờ phục vụ công khai (không có dữ liệu thật trong đó, vô hại) — gate thật
    // vẫn là mọi route /api/* bên dưới, cộng với màn AccessGate phía client khi /api/candy/me báo chưa đăng nhập.
    if (req.method === "GET" && !u.pathname.startsWith("/api/") && u.searchParams.get("email")) {
      // Chặn kiểu giả mạo "biết domain + biết đúng 1 email nhân viên là tự gõ URL đăng nhập luôn, không cần
      // qua GHL": bắt buộc kèm đúng khoá bí mật (?k=) chỉ nằm trong URL đã lưu ở Custom Menu Link trên GHL,
      // GHL không hiện lại URL này cho người xem thường. Không tách riêng thông báo lỗi theo "thiếu khoá"
      // hay "email lạ" — gộp chung 1 thông báo để không lộ manh mối cho ai đang dò.
      const row = u.searchParams.get("k") === getCmlKey() ? await findStaff(u.searchParams.get("email")) : null;
      if (!row) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(notLoggedInPage("Liên kết không hợp lệ hoặc bạn chưa được cấp quyền truy cập. Liên hệ quản lý để được hỗ trợ."));
      }
      const sid = await createSession({ email: row.email, name: row.name, role: row.role });
      let html;
      try { html = fs.readFileSync(path.join(dist, "index.html"), "utf8"); }
      catch { return res.end(notLoggedInPage("Lỗi tải ứng dụng — chưa build (npm run build)?")); }
      html = html.replace("<head>", `<head><script>window.__CANDY_TOKEN__=${JSON.stringify(sid)};</script>`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    // Tầng 2 — Custom Page trong Marketplace App (postMessage, không qua query string như Tầng 1): trang
    // của mình gửi encryptedData nhận được từ GHL lên đây để giải mã Ở PHÍA SERVER (Shared Secret không
    // bao giờ lộ ra frontend). Phải đứng TRƯỚC cổng "bắt buộc đã đăng nhập" bên dưới vì đây chính là cách
    // lấy phiên đăng nhập ĐẦU TIÊN, chưa có token nào để mang theo lúc gọi route này.
    if (req.method === "POST" && u.pathname === "/api/candy/sso-verify") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      let payload;
      try { payload = decryptGhlUserData(input.encryptedData); }
      catch (e) { return json(res, { error: "Không xác thực được dữ liệu từ GHL: " + e.message }, 400); }
      const row = await findStaff(payload.email);
      if (!row) return json(res, { error: "Tài khoản chưa được cấp quyền truy cập. Liên hệ quản lý để được thêm vào danh sách nhân viên." }, 403);
      const sid = await createSession({ email: row.email, name: row.name, role: row.role });
      return json(res, { ok: true, token: sid });
    }
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const sess = await getSession(token);
    // Lấy VAI TRÒ hiện tại từ danh sách nhân viên (findStaff), không tin vai trò lưu sẵn trong session lúc
    // đăng nhập — nếu chỉ tin session, 1 quản lý xoá quyền/hạ vai trò của ai đó thì người đó vẫn giữ quyền
    // CŨ cho tới khi tự đăng xuất, làm cho tính năng "phân quyền" gần như vô nghĩa lúc cần thu hồi khẩn.
    const liveStaff = sess ? await findStaff(sess.email) : null;
    const user = liveStaff ? { email: sess.email, name: liveStaff.name || sess.name, role: liveStaff.role } : null;
    if (u.pathname.startsWith("/api/")) {
      if (!user) {
        if (sess) await destroySession(token); // nhân viên đã bị xoá khỏi danh sách — dọn luôn session cũ
        return json(res, { error: "Chưa đăng nhập" }, 401);
      }
      if (u.pathname === "/api/candy/me") return json(res, user);
      if (req.method === "POST" && u.pathname === "/api/candy/logout") {
        await destroySession(token);
        return json(res, { ok: true });
      }
    }
    // Chặn thao tác quản trị (quản lý giáo viên, sửa quy tắc, quản lý nhân viên) ở đúng route ghi dữ liệu —
    // ẩn nút trên UI không phải là bảo mật thật, phải chặn tại đây thì mới không bypass được bằng cách gọi
    // thẳng API.
    // "lop-giao-vien" (gán 1 GV có sẵn vào lớp) KHÔNG nằm trong danh sách này — coi là thao tác vận hành
    // ngày thường, không phải thiết lập. Chỉ tạo mới/sửa hồ sơ GV, quy tắc nghiệp vụ, và quản lý nhân sự
    // mới cần quyền admin. Đây là điểm khởi đầu hợp lý — điều chỉnh lại theo đúng cơ cấu nhân sự thật.
    const ADMIN_ONLY = new Set(["/api/candy/giao-vien", "/api/candy/giao-vien-sua", "/api/candy/config", "/api/candy/staff-add", "/api/candy/staff-role", "/api/candy/staff-remove"]);
    if (req.method === "POST" && ADMIN_ONLY.has(u.pathname) && user.role !== "admin") {
      return json(res, { error: "Chỉ quản lý (admin) mới được thực hiện thao tác này" }, 403);
    }
    if (u.pathname === "/api/candy/staff-list") {
      if (user.role !== "admin") return json(res, { error: "Chỉ quản lý (admin) mới xem được danh sách nhân viên" }, 403);
      return json(res, await listStaff());
    }
    if (req.method === "POST" && u.pathname === "/api/candy/staff-add") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      try { return json(res, { ok: true, staff: await addStaff(input) }); } catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/staff-role") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      try { return json(res, { ok: true, staff: await setStaffRole(input.email, input.role) }); } catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/staff-remove") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      if (String(input.email || "").trim().toLowerCase() === String(user.email || "").trim().toLowerCase()) return json(res, { error: "Không thể tự xoá chính mình khỏi danh sách" }, 400);
      return json(res, { ok: await removeStaff(input.email) });
    }
    if (u.pathname === "/api/contacts") {
      await sleep(DELAY);
      const q = fold(u.searchParams.get("q")).trim(), tag = u.searchParams.get("tag"), sort = u.searchParams.get("sort") || "recent";
      const page = Math.max(1, Number(u.searchParams.get("page")) || 1), size = 100;
      let rows = idx.filter((x) => (!q || x.key.includes(q)) && (!tag || x.c.tags.includes(tag))).map((x) => withOverlay(x.c));
      if (sort === "xu") rows.sort((a, b) => num(b.fields["Xu tích luỹ"]) - num(a.fields["Xu tích luỹ"]));
      else if (sort === "name") rows.sort((a, b) => a.name.localeCompare(b.name, "vi"));
      else rows.sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)));
      return json(res, { total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size) });
    }
    if (u.pathname === "/api/tags") {
      await sleep(DELAY); const n = {}; for (const c of all) for (const t of c.tags) n[t] = (n[t] || 0) + 1;
      return json(res, Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 40));
    }
    let m;
    if ((m = u.pathname.match(/^\/api\/contact\/([\w-]+)$/))) {
      await sleep(DELAY); const c = all.find((x) => x.id === m[1]); if (!c) return json(res, { error: "not found" }, 404);
      return json(res, withOverlay(c));
    }
    if ((m = u.pathname.match(/^\/api\/contact\/([\w-]+)\/notes$/))) {
      const j = await ghlGet(`/contacts/${m[1]}/notes`); // read-only, live
      return json(res, (j.notes || []).slice(0, 5).map((n) => ({ at: n.dateAdded, body: String(n.body || "").slice(0, 300) })));
    }
    if (req.method === "POST" && (m = u.pathname.match(/^\/api\/contact\/([\w-]+)\/tag$/))) {
      let body = ""; for await (const ch of req) body += ch; const tag = String(JSON.parse(body).tag || "").trim().slice(0, 40);
      if (tag) overlay.set(m[1], [...(overlay.get(m[1]) || []), tag]); // LOCAL ONLY
      return json(res, { ok: true, localOnly: true });
    }
    if (u.pathname === "/api/candy/classes") {
      await sleep(DELAY);
      return json(res, allClasses().map((c) => ({ lop: c.lop, co_so: c.co_so, siso: c.students.length, trang_thai: c.trang_thai, cap_do: c.cap_do || "", giao_vien: c.giao_vien || "", si_so_toi_da: c.si_so_toi_da || "", cac_thu_hoc: c.cac_thu_hoc || "", gio_bat_dau: c.gio_bat_dau || "", gio_ket_thuc: c.gio_ket_thuc || "" })));
    }
    if ((m = u.pathname.match(/^\/api\/candy\/class\/([^/]+)$/))) {
      await sleep(DELAY);
      const lop = decodeURIComponent(m[1]);
      const date = u.searchParams.get("date") || "";
      const cls = allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "not found" }, 404);
      const key = `${lop}|${date}`;
      const overlayForDate = attOverlay[key] || {};
      const students = allStudents();
      const roster = cls.students.map((n) => {
        const s = students.find((x) => x.n === n);
        const seeded = candy.attendance_seed.find((a) => a.student_n === n && a.date === date);
        const ov = overlayForDate[n];
        const marked = ov || (seeded ? { status: seeded.status, note: seeded.note || "", real: true } : null);
        return { n: s.n, name: s.name, ghi_danh_id: s.ghi_danh_id, sessions_total: s.sessions_total, marked };
      });
      return json(res, { lop, co_so: cls.co_so, date, roster, statusLabels: ATT_STATUS });
    }
    if (u.pathname === "/api/candy/lop") {
      await sleep(DELAY);
      const lop = u.searchParams.get("lop");
      const cls = allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "not found" }, 404);
      const students = allStudents();
      const roster = cls.students.map((n) => students.find((s) => s.n === n));
      return json(res, { ...cls, roster });
    }
    // Danh sách học viên test (allowlist) để chọn khi xếp lớp — kèm các lớp đang/đã học để UI có thể
    // gợi ý loại trừ (không ghi danh trùng vào 1 lớp đã có ghi danh "đang học").
    if (u.pathname === "/api/candy/hoc-vien-test") {
      await sleep(DELAY);
      const byHocVien = new Map();
      for (const s of allStudents()) {
        if (!byHocVien.has(s.hoc_vien_id)) byHocVien.set(s.hoc_vien_id, { hoc_vien_id: s.hoc_vien_id, name: s.name, lops: [] });
        byHocVien.get(s.hoc_vien_id).lops.push({ lop: s.lop, gd_trang_thai: s.gd_trang_thai });
      }
      return json(res, [...byHocVien.values()].sort((a, b) => a.name.localeCompare(b.name, "vi")));
    }
    if (req.method === "POST" && u.pathname === "/api/candy/ghi-danh") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { hocVienId, lop, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu } = input || {};
      const student = allStudents().find((s) => s.hoc_vien_id === hocVienId);
      if (!student) return json(res, { error: "Không tìm thấy học viên trong danh sách thí điểm" }, 400);
      if (student.lop === lop && student.gd_trang_thai === "dang_hoc") return json(res, { error: `${student.name} đã đang học lớp ${lop} rồi` }, 400);
      const cls = allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "Không tìm thấy lớp" }, 400);
      const maxSiSo = Number(cls.si_so_toi_da) || 0;
      if (maxSiSo && cls.students.length >= maxSiSo) return json(res, { error: `Lớp ${lop} đã đủ sĩ số tối đa (${maxSiSo}), không thể xếp thêm` }, 400);
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        const r = await enrollStudent({ hocVienId, studentName: student.name, lop, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu });
        const row = {
          n: nextEnrollN(), name: student.name, hoc_vien_id: hocVienId, ghi_danh_id: r.ghiDanhId,
          lop, lop_id: r.lopId, co_so: cls.co_so, sessions_total: tongSoBuoi || "", fee: Number(hocPhi) || 0,
          so_buoi_da_hoc: 0, gd_trang_thai: "dang_hoc", ngay_sinh: student.ngay_sinh, hv_trang_thai: student.hv_trang_thai,
          tien_giao_cu: Number(tienGiaoCu) || 0, ngay_bat_dau: ngayBatDau, ngay_het_han: ngayHetHan || "",
        };
        enrollOverlay.push(row);
        saveEnrollOverlay();
        return json(res, { ok: true, ghi_danh_id: r.ghiDanhId, row });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Đóng vòng đời ghi danh: đổi thẳng trạng thái (Tạm nghỉ/Tiếp tục học/Hoàn thành/Đã nghỉ). KHÔNG nhận
    // "da_chuyen_lop" ở đây — trạng thái đó chỉ set được như tác dụng phụ của /chuyen-lop bên dưới.
    if (req.method === "POST" && u.pathname === "/api/candy/ghi-danh-trang-thai") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { ghiDanhId, trangThai } = input || {};
      if (trangThai === "da_chuyen_lop") return json(res, { error: "Dùng \"Chuyển lớp\" thay vì đổi trạng thái trực tiếp — cần tạo ghi danh mới đi kèm" }, 400);
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await setGhiDanhTrangThai({ ghiDanhId, trangThai });
        ghOverrides[ghiDanhId] = { ...(ghOverrides[ghiDanhId] || {}), gd_trang_thai: trangThai };
        saveGhOverrides();
        return json(res, { ok: true, ghi_danh_id: ghiDanhId, gd_trang_thai: trangThai });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Chuyển lớp: tạo 1 Ghi danh MỚI ở lớp mới (tái dùng enrollStudent) rồi đóng Ghi danh CŨ (trạng thái
    // "Đã chuyển lớp") — giữ nguyên lịch sử thay vì sửa đè, đúng cách các phần mềm chuyên nghiệp làm.
    // 2 bước ghi riêng biệt: nếu bước 2 (đóng ghi danh cũ) lỗi, vẫn giữ ghi danh mới (đã có thật trên GHL)
    // và báo rõ cho staff biết cần tự vào đóng ghi danh cũ, thay vì âm thầm nuốt lỗi.
    if (req.method === "POST" && u.pathname === "/api/candy/chuyen-lop") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { ghiDanhIdCu, hocVienId, lopMoi, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu } = input || {};
      const student = allStudents().find((s) => s.hoc_vien_id === hocVienId);
      if (!student) return json(res, { error: "Không tìm thấy học viên trong danh sách thí điểm" }, 400);
      if (student.lop === lopMoi) return json(res, { error: `Học viên đang ở lớp ${lopMoi} rồi, chọn lớp khác` }, 400);
      const cls = allClasses().find((c) => c.lop === lopMoi);
      if (!cls) return json(res, { error: "Không tìm thấy lớp mới" }, 400);
      const maxSiSo = Number(cls.si_so_toi_da) || 0;
      if (maxSiSo && cls.students.length >= maxSiSo) return json(res, { error: `Lớp ${lopMoi} đã đủ sĩ số tối đa (${maxSiSo}), không thể chuyển sang` }, 400);
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        const r = await enrollStudent({ hocVienId, studentName: student.name, lop: lopMoi, ngayBatDau, ngayHetHan, tongSoBuoi, hocPhi, tienGiaoCu });
        const row = {
          n: nextEnrollN(), name: student.name, hoc_vien_id: hocVienId, ghi_danh_id: r.ghiDanhId,
          lop: lopMoi, lop_id: r.lopId, co_so: cls.co_so, sessions_total: tongSoBuoi || "", fee: Number(hocPhi) || 0,
          so_buoi_da_hoc: 0, gd_trang_thai: "dang_hoc", ngay_sinh: student.ngay_sinh, hv_trang_thai: student.hv_trang_thai,
          tien_giao_cu: Number(tienGiaoCu) || 0, ngay_bat_dau: ngayBatDau, ngay_het_han: ngayHetHan || "",
        };
        enrollOverlay.push(row);
        saveEnrollOverlay();
        try {
          await setGhiDanhTrangThai({ ghiDanhId: ghiDanhIdCu, trangThai: "da_chuyen_lop" });
          ghOverrides[ghiDanhIdCu] = { ...(ghOverrides[ghiDanhIdCu] || {}), gd_trang_thai: "da_chuyen_lop" };
          saveGhOverrides();
        } catch (e2) {
          return json(res, { ok: true, partial: true, ghi_danh_id_moi: r.ghiDanhId, row, warning: `Đã ghi danh lớp mới thành công, nhưng KHÔNG đóng được ghi danh cũ (${String(e2.message)}) — vào lớp cũ tự đổi trạng thái.` });
        }
        return json(res, { ok: true, ghi_danh_id_moi: r.ghiDanhId, row });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Gia hạn: cập nhật ngay_het_han/tong_so_buoi trên 1 Ghi danh đã có, ghi THẬT vào GHL rồi lưu override
    // cục bộ để mọi route đọc allStudents() thấy ngay giá trị mới (không cần fetch lại từ GHL).
    if (req.method === "POST" && u.pathname === "/api/candy/gia-han") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { ghiDanhId, ngayHetHanMoi, tongSoBuoiMoi } = input || {};
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await renewEnrollment({ ghiDanhId, ngayHetHanMoi, tongSoBuoiMoi });
        const patch = {};
        if (ngayHetHanMoi) patch.ngay_het_han = ngayHetHanMoi;
        if (tongSoBuoiMoi) patch.sessions_total = tongSoBuoiMoi;
        ghOverrides[ghiDanhId] = { ...(ghOverrides[ghiDanhId] || {}), ...patch };
        saveGhOverrides();
        return json(res, { ok: true, ghi_danh_id: ghiDanhId, ...patch });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Thời khoá biểu: lưu lịch học có cấu trúc cho 1 lớp, kiểm tra trùng lịch dạy của giáo viên TRƯỚC khi
    // ghi — đây là "brain" ở backend, GHL chỉ là "hands" (đúng nguyên tắc dùng xuyên suốt stack này).
    if (req.method === "POST" && u.pathname === "/api/candy/lich-hoc") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { lop, cacThuHoc, gioBatDau, gioKetThuc } = input || {};
      const cls = allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "Không tìm thấy lớp" }, 400);
      {
        const conflict = findTeacherConflict({ lop, giaoVienTen: cls.giao_vien, cacThuHoc, gioBatDau, gioKetThuc });
        if (conflict) return json(res, { error: teacherConflictMsg(cls.giao_vien, cacThuHoc, conflict) }, 400);
      }
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await setLichHoc({ lop, cacThuHoc, gioBatDau, gioKetThuc });
        lopOverrides[lop] = { cac_thu_hoc: (cacThuHoc || []).join(","), gio_bat_dau: gioBatDau || "", gio_ket_thuc: gioKetThuc || "" };
        saveLopOverrides();
        return json(res, { ok: true, lop, ...lopOverrides[lop] });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Sinh lịch buổi học trước: tạo Buổi học cho N tuần sắp tới dựa trên cac_thu_hoc, thay vì chỉ tạo
    // phản ứng lúc điểm danh — để staff chủ động huỷ/xếp GV dạy thay trước ngày học diễn ra.
    if (req.method === "POST" && u.pathname === "/api/candy/sinh-lich-buoi-hoc") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { lop, soTuan } = input || {};
      const weeks = Math.min(Math.max(Number(soTuan) || 4, 1), 8); // chặn tối đa 8 tuần/lần — tránh dồn quá nhiều lệnh ghi 1 lúc
      const cls = allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "Không tìm thấy lớp" }, 400);
      if (!cls.cac_thu_hoc) return json(res, { error: `Lớp ${lop} chưa có lịch học — vào "Quản lý lớp" nhập lịch trước` }, 400);
      const today = toLocalISODate(new Date());
      const toDate = toLocalISODate(new Date(Date.now() + weeks * 7 * 86400000));
      const dates = datesForThu(cls.cac_thu_hoc, today, toDate);
      if (!dates.length) return json(res, { error: "Không có ngày nào khớp lịch học trong khoảng đã chọn" }, 400);
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        const results = await generateSessions({ lop, dates });
        const createdCount = results.filter((r) => r.created).length;
        return json(res, { ok: true, total: results.length, created: createdCount, existing: results.length - createdCount, dates: results });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Danh sách Buổi học của 1 lớp — màn xem theo lô sau "sinh lịch trước" (trước đây chỉ xem được
    // từng ngày 1 qua Điểm danh).
    if (u.pathname === "/api/candy/buoi-hoc-list") {
      await sleep(DELAY);
      const lop = u.searchParams.get("lop");
      if (!allClasses().find((c) => c.lop === lop)) return json(res, { error: "Không tìm thấy lớp" }, 400);
      if (!writerEnabled()) return json(res, { lop, items: [], writerEnabled: false });
      try { return json(res, { lop, items: await listBuoiHoc({ lop }), writerEnabled: true }); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    // Cập nhật 1 Buổi học từ danh sách trên — trạng thái và/hoặc GV dạy thay. Kiểm tra lop hợp lệ ở tầng
    // này TRƯỚC khi gọi xuống ghl-write.mjs, giống mọi route ghi khác trong file — không tin riêng buoiHocId.
    if (req.method === "POST" && u.pathname === "/api/candy/buoi-hoc-update") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { buoiHocId, lop, trangThai, giaoVienDay } = input || {};
      if (!allClasses().find((c) => c.lop === lop)) return json(res, { error: "Không tìm thấy lớp" }, 400);
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try { return json(res, { ok: true, ...(await updateBuoiHoc({ buoiHocId, trangThai, giaoVienDay })) }); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    // Giáo viên: danh sách + số lớp đang dạy (tính từ allClasses(), không lưu số này — luôn tính lại để
    // không bao giờ lệch với thực tế gán ở đâu đó khác).
    if (u.pathname === "/api/candy/giao-vien-list") {
      await sleep(DELAY);
      const classes = allClasses();
      return json(res, giaoVienList.map((gv) => ({ ...gv, soLopDangDay: classes.filter((c) => c.giao_vien_id === gv.id).length })));
    }
    if ((m = u.pathname.match(/^\/api\/candy\/giao-vien\/([^/]+)$/))) {
      await sleep(DELAY);
      const gv = giaoVienList.find((x) => x.id === m[1]);
      if (!gv) return json(res, { error: "Không tìm thấy giáo viên" }, 404);
      const lops = allClasses().filter((c) => c.giao_vien_id === gv.id).map((c) => ({ lop: c.lop, co_so: c.co_so, siso: c.students.length, cac_thu_hoc: c.cac_thu_hoc || "", gio_bat_dau: c.gio_bat_dau || "", gio_ket_thuc: c.gio_ket_thuc || "" }));
      return json(res, { ...gv, lops });
    }
    if (req.method === "POST" && u.pathname === "/api/candy/giao-vien") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { name, phone, email, ghiChu } = input || {};
      if (!name || !name.trim()) return json(res, { error: "Cần tên giáo viên" }, 400);
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        const r = await createGiaoVien({ name, phone, email, ghiChu });
        const row = { id: r.id, name: name.trim(), phone: phone || "", email: email || "", trang_thai: "dang_day", ghi_chu: ghiChu || "" };
        giaoVienList.push(row);
        saveGiaoVien();
        return json(res, { ok: true, giaoVien: row });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/giao-vien-sua") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { giaoVienId, name, phone, email, trangThai, ghiChu } = input || {};
      const gv = giaoVienList.find((x) => x.id === giaoVienId);
      if (!gv) return json(res, { error: "Không tìm thấy giáo viên" }, 400);
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await updateGiaoVien({ giaoVienId, name, phone, email, trangThai, ghiChu });
        Object.assign(gv, { ...(name !== undefined && { name }), ...(phone !== undefined && { phone }), ...(email !== undefined && { email }), ...(trangThai !== undefined && { trang_thai: trangThai }), ...(ghiChu !== undefined && { ghi_chu: ghiChu }) });
        saveGiaoVien();
        // Đổi tên GV thì mọi lớp đang hiện tên cũ (đã denormalize vào lopOverrides.giao_vien) cần cập nhật theo.
        if (name !== undefined) { for (const lop in lopOverrides) if (lopOverrides[lop].giao_vien_id === giaoVienId) lopOverrides[lop].giao_vien = gv.name; saveLopOverrides(); }
        return json(res, { ok: true, giaoVien: gv });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Gán GV cho 1 lớp — xoá quan hệ cũ (nếu GHL hỗ trợ), tạo quan hệ mới, rồi ghi tên+id GV vào
    // lopOverrides để mọi nơi đọc c.giao_vien (bảng lớp, thời khoá biểu, chặn trùng lịch) thấy ngay.
    if (req.method === "POST" && u.pathname === "/api/candy/lop-giao-vien") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { lop, giaoVienId } = input || {};
      const cls = allClasses().find((c) => c.lop === lop);
      if (!cls) return json(res, { error: "Không tìm thấy lớp" }, 400);
      const gv = giaoVienList.find((x) => x.id === giaoVienId);
      if (!gv) return json(res, { error: "Không tìm thấy giáo viên" }, 400);
      {
        // Hướng còn thiếu: gán GV vào 1 lớp ĐÃ có lịch học — nếu không check ở đây, vẫn có thể gán 1 GV
        // vào 2 lớp trùng giờ qua đường này (chỉ route lich-hoc kiểm tra là chưa đủ, đã bắt được lúc test).
        const conflict = findTeacherConflict({ lop, giaoVienTen: gv.name, cacThuHoc: cls.cac_thu_hoc, gioBatDau: cls.gio_bat_dau, gioKetThuc: cls.gio_ket_thuc });
        if (conflict) return json(res, { error: teacherConflictMsg(gv.name, cls.cac_thu_hoc, conflict) }, 400);
      }
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        await ganGiaoVienChoLop({ giaoVienId, lop });
        lopOverrides[lop] = { ...(lopOverrides[lop] || {}), giao_vien: gv.name, giao_vien_id: giaoVienId };
        saveLopOverrides();
        return json(res, { ok: true, lop, giao_vien: gv.name });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    // Thời khoá biểu dạng lịch tuần — chỉ những lớp ĐÃ có lịch (cac_thu_hoc) mới lên lịch; lớp chưa nhập
    // lịch không hiện (không đoán, không bịa giờ cho lớp staff chưa từng nhập).
    if (u.pathname === "/api/candy/thoi-khoa-bieu") {
      await sleep(DELAY);
      const byThu = Object.fromEntries(THU_ORDER.map((t) => [t, []]));
      for (const c of allClasses()) {
        if (!c.cac_thu_hoc) continue;
        for (const t of c.cac_thu_hoc.split(",")) {
          if (!byThu[t]) continue;
          byThu[t].push({ lop: c.lop, co_so: c.co_so, cap_do: c.cap_do || "", giao_vien: c.giao_vien || "", gio_bat_dau: c.gio_bat_dau, gio_ket_thuc: c.gio_ket_thuc, siso: c.students.length });
        }
      }
      for (const t of THU_ORDER) byThu[t].sort((a, b) => (a.gio_bat_dau || "").localeCompare(b.gio_bat_dau || ""));
      return json(res, { thuOrder: THU_ORDER, thuLabel: THU_LABEL, byThu });
    }
    // Hồ sơ học viên xuyên suốt nhiều lớp: gom mọi Ghi danh (hiện tại 1 hs = 1 ghi danh, nhưng cơ chế
    // viết theo hoc_vien_id nên tự hỗ trợ khi 1 hs từng/đang học nhiều lớp) + toàn bộ lịch sử điểm danh.
    if ((m = u.pathname.match(/^\/api\/candy\/hoc-vien\/([^/]+)$/))) {
      await sleep(DELAY);
      const hocVienId = decodeURIComponent(m[1]);
      const rows = allStudents().filter((s) => s.hoc_vien_id === hocVienId);
      if (!rows.length) return json(res, { error: "not found" }, 404);
      const enrollments = rows.map((s) => {
        const attendance = [];
        for (const seed of candy.attendance_seed) if (seed.student_n === s.n) attendance.push({ date: seed.date, status: seed.status, real: true });
        for (const key in attOverlay) {
          const [lop] = key.split("|");
          if (lop !== s.lop) continue;
          const date = key.slice(lop.length + 1);
          const mark = attOverlay[key][s.n];
          if (mark) attendance.push({ date, status: mark.status, real: !!mark.real });
        }
        attendance.sort((a, b) => (a.date < b.date ? 1 : -1));
        return { ...s, attendance };
      });
      return json(res, { hoc_vien_id: hocVienId, name: rows[0].name, enrollments });
    }
    if (req.method === "GET" && u.pathname === "/api/candy/config") {
      await sleep(DELAY);
      return json(res, candyConfig);
    }
    if (req.method === "POST" && u.pathname === "/api/candy/config") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const soBuoi = Number(input?.hoc_bu?.so_buoi_toi_da);
      if (!Number.isInteger(soBuoi) || soBuoi < 0 || soBuoi > 20) return json(res, { error: "Số buổi học bù phải là số nguyên 0-20" }, 400);
      const loai = Array.isArray(input?.hoc_bu?.loai_vang_duoc_bu) ? input.hoc_bu.loai_vang_duoc_bu.filter((x) => ["vang_co_phep", "vang_khong_phep"].includes(x)) : [];
      candyConfig = { hoc_bu: { ...candyConfig.hoc_bu, so_buoi_toi_da: soBuoi, loai_vang_duoc_bu: loai } };
      saveConfig();
      return json(res, candyConfig);
    }
    if (u.pathname === "/api/candy/dashboard") {
      await sleep(DELAY);
      const students = allStudents();
      const classes = allClasses();
      // Ghi danh đã đóng (chuyển lớp/hoàn thành/nghỉ hẳn) không còn "active" — loại khỏi số liệu tổng hợp,
      // nếu không 1 người chuyển lớp sẽ bị đếm 2 lần (ghi danh cũ + mới) trong mọi thống kê bên dưới.
      const TERMINAL = new Set(["da_chuyen_lop", "hoan_thanh", "da_nghi"]);
      const isActive = (s) => !TERMINAL.has(s.gd_trang_thai);
      const activeStudents = students.filter(isActive);
      const totalStudents = new Set(activeStudents.map((s) => s.hoc_vien_id)).size; // đếm NGƯỜI, không đếm dòng ghi danh
      const byCoSo = {};
      for (const s of activeStudents) byCoSo[s.co_so] = (byCoSo[s.co_so] || 0) + 1;
      let realAtt = 0, demoAtt = 0, absentCount = 0;
      const statusCount = {};
      for (const seed of candy.attendance_seed) { realAtt++; statusCount[seed.status] = (statusCount[seed.status] || 0) + 1; if (seed.status.startsWith("vang")) absentCount++; }
      for (const key in attOverlay) for (const n in attOverlay[key]) {
        const mark = attOverlay[key][n];
        if (mark.real) continue; // already counted via seed-equivalent path below if applicable
        demoAtt++; statusCount[mark.status] = (statusCount[mark.status] || 0) + 1;
        if (mark.status.startsWith("vang")) absentCount++;
      }
      const totalPhi = activeStudents.reduce((sum, s) => sum + (Number(s.fee) || 0), 0);

      // "Cần chú ý hôm nay" — chuẩn Teachworks/Glofox: cảnh báo sắp hết hạn + vắng liên tiếp, KHÔNG
      // chỉ liệt kê số liệu. Đây là phần đầu trang, trước mọi biểu đồ tổng hợp.
      const TODAY = new Date();
      const expiringSoon = activeStudents
        .map((s) => ({ name: s.name, lop: s.lop, hoc_vien_id: s.hoc_vien_id, ngay_het_han: s.ngay_het_han, daysLeft: s.ngay_het_han ? Math.floor((new Date(s.ngay_het_han) - TODAY) / 86400000) : null }))
        .filter((x) => x.daysLeft !== null && x.daysLeft <= 30)
        .sort((a, b) => a.daysLeft - b.daysLeft);

      // Gom mọi lượt điểm danh (thật + demo) theo từng học viên, sắp theo ngày, xét chuỗi vắng gần nhất.
      const byStudent = {};
      for (const a of candy.attendance_seed) (byStudent[a.student_n] ||= []).push({ date: a.date, status: a.status });
      for (const key in attOverlay) {
        const date = key.split("|")[1];
        for (const n in attOverlay[key]) (byStudent[n] ||= []).push({ date, status: attOverlay[key][n].status });
      }
      const absentStreak = [];
      for (const [nStr, marks] of Object.entries(byStudent)) {
        const n = Number(nStr);
        const sorted = [...marks].sort((a, b) => (a.date < b.date ? 1 : -1)); // mới nhất trước
        let streak = 0;
        for (const m of sorted) { if (m.status.startsWith("vang")) streak++; else break; }
        if (streak >= 2) {
          const s = students.find((x) => x.n === n);
          absentStreak.push({ name: s.name, lop: s.lop, hoc_vien_id: s.hoc_vien_id, streak });
        }
      }
      absentStreak.sort((a, b) => b.streak - a.streak);

      // "Hôm nay có gì" — chuẩn dashboard vận hành (Teachworks/Glofox mở app là thấy ngay lịch hôm nay),
      // kéo thẳng từ dữ liệu Thời khoá biểu, lọc theo đúng thứ hôm nay, sắp theo giờ bắt đầu.
      const todayThu = JS_DAY_TO_THU[new Date().getDay()];
      const todaySessions = classes
        .filter((c) => c.cac_thu_hoc && c.cac_thu_hoc.split(",").includes(todayThu))
        .map((c) => ({ lop: c.lop, co_so: c.co_so, gio_bat_dau: c.gio_bat_dau, gio_ket_thuc: c.gio_ket_thuc, giao_vien: c.giao_vien || "", siso: c.students.length }))
        .sort((a, b) => (a.gio_bat_dau || "").localeCompare(b.gio_bat_dau || ""));

      // Cảnh báo hành động mới — lớp CÓ học viên nhưng còn thiếu thông tin vận hành cơ bản. Lớp trống học
      // viên (17/30) không tính vào đây vì chưa cần giáo viên/lịch học thật, tránh cảnh báo giả.
      const activeClasses = classes.filter((c) => c.students.length > 0);
      const lopChuaCoGV = activeClasses.filter((c) => !c.giao_vien).map((c) => c.lop);
      const lopChuaCoLich = activeClasses.filter((c) => !c.cac_thu_hoc).map((c) => c.lop);

      return json(res, {
        totalStudents, totalClasses: classes.length, classesWithStudents: classes.filter((c) => c.students.length).length, byCoSo,
        attendance: { real: realAtt, demo: demoAtt, statusCount, absentCount },
        totalPhi, expiringSoon, absentStreak, todaySessions, todayThu, thuLabel: THU_LABEL,
        lopChuaCoGV, lopChuaCoLich, tongHocBuDaDat: hocBuOverlay.length,
        note: "Đây là dữ liệu thí điểm (18 học viên) nên số liệu điểm danh còn ít, chỉ minh hoạ cách tính chứ chưa đại diện cho toàn trung tâm. Học phí đang lấy từ dữ liệu cũ, sẽ chuẩn hoá khi hoàn tất chuyển đổi.",
      });
    }
    if ((m = u.pathname.match(/^\/api\/candy\/phu-huynh\/([^/]+)$/))) {
      await sleep(DELAY);
      if (!writerEnabled()) return json(res, { phuHuynh: null, writerEnabled: false });
      try { return json(res, { phuHuynh: await getPhuHuynh({ hocVienId: decodeURIComponent(m[1]) }), writerEnabled: true }); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "GET" && u.pathname === "/api/candy/buoi-hoc") {
      const lop = u.searchParams.get("lop"), date = u.searchParams.get("date");
      if (!writerEnabled()) return json(res, { buoiHoc: null, writerEnabled: false });
      try { return json(res, { buoiHoc: await getBuoiHoc({ lop, date }), writerEnabled: true }); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/buoi-hoc") {
      let body = ""; for await (const ch of req) body += ch;
      const { lop, date, trang_thai } = JSON.parse(body);
      try { return json(res, await setBuoiHocTrangThai({ lop, date, trangThai: trang_thai })); }
      catch (e) { return json(res, { error: String(e.message) }, 400); }
    }
    if (req.method === "POST" && u.pathname === "/api/candy/attendance") {
      let body = ""; for await (const ch of req) body += ch;
      const { lop, date, marks } = JSON.parse(body); // marks: {studentN: {status, note}}
      const key = `${lop}|${date}`;
      const results = [];
      const merged = { ...(attOverlay[key] || {}) };
      for (const [nStr, mark] of Object.entries(marks)) {
        const n = Number(nStr);
        const existing = merged[n];
        if (existing?.real) { results.push({ n, status: "skipped_already_real" }); continue; } // never re-write an already-confirmed real record
        const seeded = candy.attendance_seed.find((a) => a.student_n === n && a.date === date);
        if (seeded) { merged[n] = { ...mark, real: true }; results.push({ n, status: "already_real_seed" }); continue; }
        const student = allStudents().find((s) => s.n === n);
        if (writerEnabled()) {
          try {
            const r = await writeAttendance({ studentName: student.name, ghiDanhId: student.ghi_danh_id, lop, date, status: mark.status, note: mark.note || "" });
            merged[n] = { status: mark.status, note: mark.note || "", real: true, diem_danh_id: r.diemDanhId, buoi_hoc_id: r.buoiHocId };
            // writeAttendance() vừa cộng dồn so_buoi_da_hoc thật trên GHL (nếu Có mặt/Muộn) — nhưng allStudents()
            // đọc field này từ snapshot tĩnh + ghOverrides, không đọc live từ GHL, nên phải ghi đè vào đây thì
            // "Đã học/Tổng buổi" trên UI mới khớp giá trị thật vừa cập nhật, không riêng gì GHL đúng còn app sai.
            if (r.soBuoiDaHoc !== undefined) { ghOverrides[student.ghi_danh_id] = { ...(ghOverrides[student.ghi_danh_id] || {}), so_buoi_da_hoc: r.soBuoiDaHoc }; saveGhOverrides(); }
            results.push({ n, status: "written", diem_danh_id: r.diemDanhId });
          } catch (e) {
            merged[n] = { ...mark, real: false, error: String(e.message) };
            results.push({ n, status: "error", error: String(e.message) });
          }
        } else {
          merged[n] = { ...mark, real: false };
          results.push({ n, status: "local_only_no_token" });
        }
      }
      attOverlay[key] = merged;
      saveAttOverlay();
      const written = results.filter((r) => r.status === "written").length;
      const errors = results.filter((r) => r.status === "error");
      return json(res, { ok: true, writerEnabled: writerEnabled(), written, total: results.length, results, errors });
    }
    // Quota học bù của 1 Ghi danh: đã dùng bao nhiêu / tối đa bao nhiêu (theo Cấu hình), kèm danh sách các
    // lượt đã đặt — để UI biết buổi vắng nào ĐÃ có bù rồi (không cho đặt lại) và hiện rõ còn lại bao nhiêu suất.
    if (u.pathname === "/api/candy/hoc-bu") {
      await sleep(DELAY);
      const ghiDanhId = u.searchParams.get("ghiDanhId");
      const bookings = hocBuOverlay.filter((b) => b.ghiDanhId === ghiDanhId);
      return json(res, { used: bookings.length, max: candyConfig.hoc_bu.so_buoi_toi_da, loaiVangDuocBu: candyConfig.hoc_bu.loai_vang_duoc_bu, bookings });
    }
    // Lớp cùng cấp độ với 1 lớp gốc — để chọn lớp bù (quy tắc đã chốt: học bù CÙNG CẤP ĐỘ). Chỉ hiện lớp
    // đã có lịch học (cac_thu_hoc) vì cần biết lớp đó học vào thứ mấy để validate ngày bù chọn có khớp không.
    if (u.pathname === "/api/candy/lop-cung-cap-do") {
      await sleep(DELAY);
      const lop = u.searchParams.get("lop");
      const clsGoc = allClasses().find((c) => c.lop === lop);
      if (!clsGoc) return json(res, { error: "Không tìm thấy lớp" }, 400);
      const list = allClasses().filter((c) => c.lop !== lop && c.cap_do && c.cap_do === clsGoc.cap_do && c.cac_thu_hoc);
      return json(res, { capDo: clsGoc.cap_do || "", list });
    }
    // Đặt lịch học bù thực tế: kiểm tra đủ 4 điều kiện (chưa đặt bù cho buổi vắng này, còn hạn dùng, còn
    // quota, lớp bù cùng cấp độ + đúng ngày lịch học) TRƯỚC khi ghi — GHL vẫn chỉ là "hands", luật nằm ở đây.
    if (req.method === "POST" && u.pathname === "/api/candy/dat-hoc-bu") {
      let body = ""; for await (const ch of req) body += ch;
      let input; try { input = JSON.parse(body); } catch { return json(res, { error: "invalid json" }, 400); }
      const { ghiDanhId, ngayVang, loaiVang, lopGoc, lopBu, ngayBu } = input || {};
      const student = allStudents().find((s) => s.ghi_danh_id === ghiDanhId);
      if (!student) return json(res, { error: "Không tìm thấy ghi danh" }, 400);
      if (candyConfig.hoc_bu.loai_vang_duoc_bu.length && !candyConfig.hoc_bu.loai_vang_duoc_bu.includes(loaiVang)) {
        return json(res, { error: `Loại vắng "${ATT_STATUS[loaiVang] || loaiVang}" không được phép học bù theo quy tắc hiện tại (xem tab Cấu hình)` }, 400);
      }
      if (hocBuOverlay.find((b) => b.ghiDanhId === ghiDanhId && b.ngayVang === ngayVang)) {
        return json(res, { error: "Buổi vắng này đã được đặt học bù rồi" }, 400);
      }
      if (student.ngay_het_han && ngayBu > student.ngay_het_han) {
        return json(res, { error: `Ngày bù phải trước ngày hết hạn gói học (${student.ngay_het_han})` }, 400);
      }
      const daDat = hocBuOverlay.filter((b) => b.ghiDanhId === ghiDanhId).length;
      if (daDat >= candyConfig.hoc_bu.so_buoi_toi_da) {
        return json(res, { error: `Đã dùng hết ${candyConfig.hoc_bu.so_buoi_toi_da} buổi học bù cho phép mỗi kỳ ghi danh (xem tab Cấu hình)` }, 400);
      }
      const clsGoc = allClasses().find((c) => c.lop === lopGoc);
      const clsBu = allClasses().find((c) => c.lop === lopBu);
      if (!clsBu) return json(res, { error: "Không tìm thấy lớp bù" }, 400);
      if (clsGoc?.cap_do && clsBu.cap_do !== clsGoc.cap_do) {
        return json(res, { error: `Lớp bù phải cùng cấp độ (${clsGoc.cap_do}) với lớp gốc — ${lopBu} là "${clsBu.cap_do || "chưa có cấp độ"}"` }, 400);
      }
      if (clsBu.cac_thu_hoc) {
        const thuBu = JS_DAY_TO_THU[new Date(ngayBu + "T00:00:00").getDay()];
        if (!clsBu.cac_thu_hoc.split(",").includes(thuBu)) {
          return json(res, { error: `Lớp ${lopBu} không học vào ${THU_LABEL[thuBu]} — chọn ngày khác đúng lịch của lớp (${clsBu.cac_thu_hoc.split(",").map((t) => THU_LABEL[t]).join(", ")})` }, 400);
        }
      }
      if (!writerEnabled()) return json(res, { error: "Chưa bật ghi thật (thiếu GHL_PIT)" }, 400);
      try {
        const r = await writeAttendance({ studentName: student.name, ghiDanhId, lop: lopBu, date: ngayBu, status: "co_mat", note: `Học bù cho buổi vắng ngày ${ngayVang} tại lớp ${lopGoc}` });
        if (r.soBuoiDaHoc !== undefined) { ghOverrides[ghiDanhId] = { ...(ghOverrides[ghiDanhId] || {}), so_buoi_da_hoc: r.soBuoiDaHoc }; saveGhOverrides(); }
        const row = { id: `hb_${Date.now()}`, ghiDanhId, hocVienId: student.hoc_vien_id, ten: student.name, lopGoc, ngayVang, lopBu, ngayBu, diemDanhBuId: r.diemDanhId, taoLuc: new Date().toISOString() };
        hocBuOverlay.push(row);
        saveHocBuOverlay();
        return json(res, { ok: true, booking: row });
      } catch (e) {
        return json(res, { error: String(e.message) }, 400);
      }
    }
    let f = path.join(dist, u.pathname === "/" ? "index.html" : u.pathname);
    if (!f.startsWith(dist) || !fs.existsSync(f)) f = path.join(dist, "index.html");
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  } catch (e) { json(res, { error: String(e.message || e) }, 500); }
}).listen(5178, "127.0.0.1", () => console.log("Demo: http://127.0.0.1:5178  (chỉ máy này truy cập được)"));
