#!/usr/bin/env node
/**
 * 盤點 TDX 有哪些捷運系統、各自幾站——用來確認「新站」屬於哪個業者。
 * 我們的資料管線目前只抓 TRTC（台北捷運公司五線）；環狀線、安坑／淡海輕軌、
 * 三鶯線屬新北捷運公司（NTMC），是另一個業者代碼。
 *
 * 只打 2–3 次 API 且用 $select 縮小回應。用法：node scripts/probe-metro.mjs
 */
const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
if (!id || !secret) { console.log("::warning::未設定 TDX 金鑰，跳過"); process.exit(0); }

const tokRes = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
});
if (!tokRes.ok) {
  console.log(`::warning::TDX token 回應 ${tokRes.status}——本輪跳過`);
  process.exit(0);
}
const token = (await tokRes.json()).access_token;

const BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, label) {
  const r = await fetch(`${BASE}/${path}`, { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
  if (!r.ok) { console.log(`::warning::${label} 回應 ${r.status}`); return null; }
  return r.json();
}

// 逐一問「這個業者幾站」。TRTC 拿來對照，其餘是我們還沒接的系統。
// $select 只挑 Station 真的有的欄位——帶了不存在的欄位 TDX 會直接回 400。
let first = true;
for (const op of ["TRTC", "NTMC", "NTDLRT", "TYMC", "KRTC", "TMRT"]) {
  if (!first) await sleep(13500); // TDX 免費層約每分鐘 5 次
  first = false;
  const rows = await get(`Station/${op}?%24select=StationID%2CStationName&%24format=JSON`, `${op} 車站`);
  if (!Array.isArray(rows)) continue;
  const byPrefix = {};
  for (const s of rows) {
    const p = String(s.StationID ?? "").replace(/\d+$/, "") || "?";
    (byPrefix[p] ??= []).push(s.StationName?.Zh_tw ?? s.StationID);
  }
  const groups = Object.entries(byPrefix).sort((a, b) => b[1].length - a[1].length);
  console.log(`\n【${op}】${rows.length} 站，代碼前綴 ${groups.length} 組`);
  for (const [p, names] of groups) {
    console.log(`  ${p.padEnd(4)} ${String(names.length).padStart(3)} 站：${names.slice(0, 6).join("、")}${names.length > 6 ? "…" : ""}`);
  }
}
