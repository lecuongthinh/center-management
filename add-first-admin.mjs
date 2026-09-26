// Thêm nhân viên ĐẦU TIÊN (admin) cho 1 tenant vừa provision — bảng staff của schema mới tạo luôn TRỐNG,
// nên nếu không có bước này thì không ai đăng nhập được (findStaff luôn trả về null, kể cả qua GHL SSO thật).
// Sau bước này, chính admin đó tự thêm các nhân viên khác qua UI (Cấu hình > Phân quyền nhân viên).
//
// Dùng: node add-first-admin.mjs <schemaName> <email> [tên hiển thị]
import { addStaff } from "./db.mjs";

const [schemaName, email, name] = process.argv.slice(2);
if (!schemaName || !email) {
  console.error("Thiếu tham số. Dùng: node add-first-admin.mjs <schemaName> <email> [tên hiển thị]");
  process.exit(1);
}

const row = await addStaff(schemaName, { email, name: name || email, role: "admin" });
console.log("Đã thêm admin:", row);
process.exit(0);
