// Khởi tạo 1 khách hàng (tenant) MỚI trong 1 lệnh: tạo schema Postgres riêng (kv_store + staff) + đăng ký
// vào bảng điều khiển platform.tenants. Sau bước này, khách hàng chỉ còn cần (1) load GHL Snapshot vào
// subaccount của họ, và (2) bấm Install Marketplace App trên subaccount đó — không cần deploy gì thêm.
//
// Dùng:
//   node provision-tenant.mjs <schemaName> <locationId> <ghlPit> <brandName> <brandMark> <orgLabel> <menuLabel>
//
// Ví dụ:
//   node provision-tenant.mjs abc_academy AbCdEfGhIjKlMnOpQrSt "pit-xxxxxxxx" "ABC Academy" "AA" "ABC Academy" "ABC Academy — Vận hành"
//
// schemaName: chữ thường + số + gạch dưới, KHÔNG trùng tenant đã có (kiểm tra trong platform.tenants nếu không chắc).
// ghlPit: Private Integration Token tạo trên CHÍNH subaccount của khách đó (Settings > Private Integrations),
//         cần quyền đọc/ghi Objects + Associations (không cần quyền Contacts nếu không dùng module đó).
import { ensureTenantSchema, upsertTenant, listTenants } from "./db.mjs";

const [schemaName, locationId, ghlPit, brandName, brandMark, orgLabel, menuLabel] = process.argv.slice(2);
if (!schemaName || !locationId || !ghlPit || !brandName || !brandMark || !orgLabel || !menuLabel) {
  console.error("Thiếu tham số. Dùng: node provision-tenant.mjs <schemaName> <locationId> <ghlPit> <brandName> <brandMark> <orgLabel> <menuLabel>");
  process.exit(1);
}

const existing = await listTenants();
const dup = existing.find((t) => t.schema_name === schemaName && t.location_id !== locationId);
if (dup) {
  console.error(`Schema "${schemaName}" đã được dùng bởi location khác (${dup.location_id}) — chọn tên schema khác.`);
  process.exit(1);
}

console.log(`Tạo schema "${schemaName}" (nếu chưa có)...`);
await ensureTenantSchema(schemaName);

console.log(`Đăng ký tenant vào platform.tenants...`);
const row = await upsertTenant({ locationId, schemaName, ghlPit, brandName, brandMark, orgLabel, menuLabel });

console.log("Xong. Tenant:", { location_id: row.location_id, schema_name: row.schema_name, brand_name: row.brand_name });
console.log(`\nBước tiếp theo: thêm ít nhất 1 nhân viên admin bằng cách chạy:`);
console.log(`  node add-first-admin.mjs ${schemaName} <email-admin>`);
process.exit(0);
