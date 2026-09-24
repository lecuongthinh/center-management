// Deletes the local snapshot when the demo is finished.
import fs from "fs";
fs.rmSync(new URL("./data", import.meta.url), { recursive: true, force: true });
console.log("Đã xóa thư mục data/ (bản sao khách hàng).");
