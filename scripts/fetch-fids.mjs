#!/usr/bin/env node
/**
 * 抓取 TDX 民航 FIDS 桃園機場出發＋抵達看板 → data/fids.json（同網域供航班頁使用）。
 * 結構與 as-jx 的 tdx.json 相容（airports.TPE.dep/arr）。
 * 用法：node scripts/fetch-fids.mjs（需 TDX_CLIENT_ID/TDX_CLIENT_SECRET）
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
if (!id || !secret) { console.error("缺 TDX 金鑰"); process.exit(1); }
const tokRes = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
});
if (!tokRes.ok) { console.error(`token 失敗 ${tokRes.status}`); process.exit(1); }
const token = (await tokRes.json()).access_token;

async function fetchRetry(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
    if (r.status === 429 && i < 2) {
      console.log("  （限流，65 秒後重試）");
      await new Promise((res) => setTimeout(res, 65000));
      continue;
    }
    return r;
  }
}

// 台灣時間（分鐘解析度）
const nowTW = new Date(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(" ", "T"));
const lo = new Date(nowTW.getTime() - 90 * 60000);
const hi = new Date(nowTW.getTime() + 12 * 3600000);
const hm = (s) => { try { return s.slice(11, 16); } catch { return ""; } };

function norm(rows, kind) {
  const p = kind === "dep" ? "Departure" : "Arrival";
  const groups = new Map();
  for (const r of rows) {
    if (r.IsCargo) continue;
    const st = r[`Schedule${p}Time`], et = r[`Estimated${p}Time`], at = r[`Actual${p}Time`];
    const t = at || et || st;
    if (!t) continue;
    const tt = new Date(t.slice(0, 19));
    if (Number.isNaN(+tt) || tt < lo || tt > hi) continue;
    const other = (kind === "dep" ? r.ArrivalAirportID : r.DepartureAirportID) || "";
    const fno = `${r.AirlineID ?? ""}${r.FlightNumber ?? ""}`;
    const key = `${st}|${other}|${(r.Gate ?? "").trim()}`;
    const g = groups.get(key);
    if (g) {
      // 同班多班號＝共掛；有機型者視為承運班號
      if (r.AcType && !g.ac) { g.cs.push(g.f); g.f = fno; g.ac = r.AcType; }
      else g.cs.push(fno);
      continue;
    }
    groups.set(key, {
      f: fno, cs: [], o: other,
      st: hm(st ?? ""), et: hm(et ?? ""), at: hm(at ?? ""),
      rm: (r[`${p}Remark`] ?? "").trim(),
      gate: (r.Gate ?? "").trim(),
      term: (r.Terminal ?? "").trim(),
      belt: (r.BaggageClaim ?? "").trim(),
      ck: (r.CheckCounter ?? r.CheckinCounter ?? "").trim(),
      ac: r.AcType ?? "",
      _t: t,
    });
  }
  const out = [...groups.values()].sort((a, b) => a._t.localeCompare(b._t)).slice(0, 70);
  for (const x of out) delete x._t;
  return out;
}

const data = { updated_at: nowTW.toISOString().slice(0, 16).replace("T", " "), airports: { TPE: {} } };
for (const [kind, path] of [["dep", "Departure"], ["arr", "Arrival"]]) {
  if (kind === "arr") await new Promise((r) => setTimeout(r, 1500));
  // 不帶 $top：FIDS 依時間升冪，$top 會截到最舊（昨日）的班次
  const res = await fetchRetry(`https://tdx.transportdata.tw/api/basic/v2/Air/FIDS/Airport/${path}/TPE?%24format=JSON`);
  if (!res.ok) { console.error(`${path} 失敗 ${res.status}`); process.exit(1); }
  const raw = await res.json();
  const rows = Array.isArray(raw) ? raw : raw?.FIDSAirports ?? raw?.data ?? [];
  data.airports.TPE[kind] = norm(rows, kind);
  console.log(`${kind}: raw ${rows.length} → ${data.airports.TPE[kind].length} 班`);
  if (!data.airports.TPE[kind].length) {
    if (!Array.isArray(raw)) console.log("非陣列回應，鍵:", Object.keys(raw ?? {}).join(","));
    if (rows.length) console.log("首筆樣本:", JSON.stringify(rows[0]).slice(0, 500));
  }
}

if ((data.airports.TPE.dep?.length ?? 0) < 3) { console.error("出發班次過少，疑似資料異常，不寫檔"); process.exit(1); }
writeFileSync(join(root, "data/fids.json"), JSON.stringify(data));
console.log("已寫入 data/fids.json");
