// Read-only GHL client for the demo. Only GET exists here on purpose: there is no function that can
// write, and the token is read from the 123gym-server .env at run time (never copied, never sent to a browser).
import fs from "fs";
const ENV_PATH = new URL("../123gym-server/.env", import.meta.url);
const env = Object.fromEntries(fs.readFileSync(ENV_PATH, "utf8").split("\n").filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
export const LOCATION_ID = env.GHL_LOCATION_ID; // Bạch Đằng
const BASE = env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const H = { Authorization: `Bearer ${env.GHL_PRIVATE_TOKEN}`, Version: env.GHL_API_VERSION || "2021-07-28", Accept: "application/json" };
export async function ghlGet(path) {
  if (!path.startsWith("/")) throw new Error("bad path");
  const r = await fetch(BASE + path, { method: "GET", headers: H });
  if (!r.ok) throw new Error(`GHL GET ${path.split("?")[0]} -> ${r.status}`);
  return r.json();
}

// Used ONLY by ghl-write-guarded.mjs (which enforces the allowlist). Kept separate from ghlGet on purpose.
export async function ghlRequest(method, path, body) {
  if (!["POST", "DELETE"].includes(method)) throw new Error("bad method");
  const r = await fetch(BASE + path, { method, headers: { ...H, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const e = new Error(`GHL ${method} ${path.replace(/\/contacts\/[^/]+/, "/contacts/<id>")} -> ${r.status}`); e.status = r.status; throw e; }
  return r.status === 204 ? {} : r.json().catch(() => ({}));
}
