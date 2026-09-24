// Kết nối Postgres dùng chung (Supabase project "lecuongthinh", schema riêng candy_english — cùng project
// với growthLEADERs/uplifting nhưng KHÔNG đụng bảng của họ, chỉ thao tác trong schema này). Thay cho việc
// lưu trạng thái vận hành (nhân viên/phiên đăng nhập/cấu hình/override lớp...) ra file JSON cục bộ — file
// cục bộ sẽ MẤT SẠCH mỗi lần Render redeploy (ổ đĩa không bền), còn Postgres thì không.
// candy_attendance.json (ảnh chụp gốc lúc migrate) và data/contacts.json (module 123 GYM riêng, không
// deploy) CHƯA chuyển sang đây — vẫn là file tĩnh, ít thay đổi, để đợt sau.
import pg from "pg";
const { Pool } = pg;

const ENV_PATH = new URL("./.env", import.meta.url);
import fs from "fs";
const fileEnv = fs.existsSync(ENV_PATH)
  ? Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }))
  : {};
const DATABASE_URL = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Thiếu DATABASE_URL trong .env — chuỗi kết nối Postgres (Supabase > Connect)");

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// --- Kho key-value chung (thay cho các file overlay/config nhỏ) -----------------------------------------
// Mỗi "file" cũ (candy_lop_overrides.json, candy_giaovien.json, candy_config.json...) giờ là 1 row, key =
// tên logic, value = nguyên object/array JSON y hệt trước đây — đổi ít code nhất có thể ở phía gọi.
export async function kvGet(key, fallback) {
  const r = await pool.query("select value from candy_english.kv_store where key = $1", [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}
export async function kvSet(key, value) {
  await pool.query(
    "insert into candy_english.kv_store (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()",
    [key, JSON.stringify(value)]
  );
}

// --- Nhân viên (đăng nhập/phân quyền) --------------------------------------------------------------------
const norm = (email) => String(email || "").trim().toLowerCase();

export async function findStaff(email) {
  const r = await pool.query("select email, name, role, added_at from candy_english.staff where email = $1", [norm(email)]);
  return r.rows[0] || null;
}
export async function listStaff() {
  const r = await pool.query("select email, name, role, added_at from candy_english.staff order by added_at asc");
  return r.rows;
}
export async function addStaff({ email, name, role }) {
  email = norm(email);
  if (!email || !email.includes("@")) throw new Error("Email không hợp lệ");
  if (await findStaff(email)) throw new Error("Email này đã có trong danh sách nhân viên");
  const r = await pool.query(
    "insert into candy_english.staff (email, name, role) values ($1, $2, $3) returning email, name, role, added_at",
    [email, (name || "").trim() || email, role === "admin" ? "admin" : "staff"]
  );
  return r.rows[0];
}
export async function setStaffRole(email, role) {
  const r = await pool.query(
    "update candy_english.staff set role = $2 where email = $1 returning email, name, role, added_at",
    [norm(email), role === "admin" ? "admin" : "staff"]
  );
  if (!r.rows[0]) throw new Error("Không tìm thấy nhân viên với email này");
  return r.rows[0];
}
export async function removeStaff(email) {
  const r = await pool.query("delete from candy_english.staff where email = $1", [norm(email)]);
  return r.rowCount > 0;
}

// --- Phiên đăng nhập --------------------------------------------------------------------------------------
export async function createSession({ email, name, role }) {
  const id = (await import("crypto")).randomBytes(24).toString("hex");
  await pool.query("insert into candy_english.sessions (id, email, name, role) values ($1,$2,$3,$4)", [id, email, name, role]);
  return id;
}
export async function getSession(id) {
  if (!id) return null;
  const r = await pool.query("select email, name, role, created_at from candy_english.sessions where id = $1", [id]);
  return r.rows[0] || null;
}
export async function destroySession(id) {
  if (id) await pool.query("delete from candy_english.sessions where id = $1", [id]);
}
