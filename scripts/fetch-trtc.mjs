#!/usr/bin/env node
/**
 * 抓取 TDX 台北捷運（TRTC）靜態資料 → data/trtc.json、data/trtc-fares.json
 * 北捷為班距制、無逐班時刻表，全部資料皆屬靜態（週更即可）：
 * 車站／路線站序／站間行駛時間／轉乘步行時間／班距／首末班車／全 OD 票價。
 * 各區塊獨立容錯；印出首筆樣本供 schema 驗證。
 * 用法：node scripts/fetch-trtc.mjs（需 TDX_CLIENT_ID/TDX_CLIENT_SECRET）
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = (f, obj) => writeFileSync(join(root, "data", f), JSON.stringify(obj));

const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
if (!id || !secret) { console.error("缺 TDX 金鑰"); process.exit(1); }
// 額度用罄／金鑰停用（TDX 回 401/403）不算「壞掉」：保留線上既有資料、
// 溫和跳出，避免每半小時寄一封失敗信。真正的異常仍以非零碼結束。
const quotaOut = (status, where) => {
  console.log(`::warning::TDX ${where} 回應 ${status}——金鑰可能已達額度上限或被停用，本輪跳過，沿用既有資料`);
  process.exit(0);
};

const tokRes = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
});
if (!tokRes.ok) {
  if ([401, 403, 429].includes(tokRes.status)) quotaOut(tokRes.status, "token");
  console.error(`token 失敗 ${tokRes.status}`); process.exit(1);
}
const token = (await tokRes.json()).access_token;

const BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nap = () => sleep(13500); // TDX 免費層約每分鐘 5 次
async function get(path) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/${path}${path.includes("?") ? "&" : "?"}%24format=JSON`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (r.status === 429 && i < 2) { console.log("  （限流，65 秒後重試）"); await sleep(65000); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path.split("?")[0]}`);
    return r.json();
  }
}
const sample = (tag, arr) => arr?.[0] && console.log(`${tag} 首筆樣本:`, JSON.stringify(arr[0]).slice(0, 450));

const stamp = new Date(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(" ", "T"))
  .toISOString().slice(0, 16).replace("T", " ");
const data = { updated: stamp, stations: {}, lines: {}, transfers: [], firstLast: {}, freq: [] };
let ok = 0;

/* ── 車站（座標＋名稱） ── */
try {
  const raw = await get("Station/TRTC");
  sample("車站", raw);
  for (const s of raw) {
    data.stations[s.StationID] = {
      zh: s.StationName?.Zh_tw ?? "",
      en: s.StationName?.En ?? "",
      lat: s.StationPosition?.PositionLat ?? null,
      lon: s.StationPosition?.PositionLon ?? null,
    };
  }
  if (Object.keys(data.stations).length < 100) throw new Error(`僅 ${Object.keys(data.stations).length} 站`);
  console.log(`✓ 車站 ${Object.keys(data.stations).length} 站`);
  ok++;
} catch (e) { console.log(`::warning::TRTC 車站失敗：${e.message}`); }

/* ── 路線站序 ── */
try {
  await nap();
  const raw = await get("StationOfLine/TRTC");
  sample("站序", raw);
  for (const l of raw) {
    data.lines[l.LineID] = {
      stations: (l.Stations ?? []).sort((a, b) => (a.Sequence ?? 0) - (b.Sequence ?? 0)).map((s) => s.StationID),
    };
  }
  if (Object.keys(data.lines).length < 4) throw new Error(`僅 ${Object.keys(data.lines).length} 線`);
  console.log(`✓ 路線 ${Object.keys(data.lines).length} 線：${Object.keys(data.lines).join(",")}`);
  ok++;
} catch (e) { console.log(`::warning::TRTC 路線失敗：${e.message}`); }

/* ── 站間行駛時間（含停站秒數） ── */
try {
  await nap();
  const raw = await get("S2STravelTime/TRTC");
  sample("站間", raw);
  // 回應按「線×路線」分列（BL-1、BL-2…），須合併去重而非覆蓋
  for (const l of raw) {
    const line = data.lines[l.LineID] ?? (data.lines[l.LineID] = { stations: [] });
    line.s2s ??= [];
    const seen = new Set(line.s2s.map(([a, b]) => `${a}|${b}`));
    for (const x of l.TravelTimes ?? []) {
      const key = `${x.FromStationID}|${x.ToStationID}`;
      if (seen.has(key) || seen.has(`${x.ToStationID}|${x.FromStationID}`)) continue;
      seen.add(key);
      line.s2s.push([
        x.FromStationID, x.ToStationID,
        Math.round(((x.RunTime ?? 0) + (x.StopTime ?? 0)) / 6) / 10, // 分鐘（一位小數）
      ]);
    }
  }
  const segs = Object.values(data.lines).reduce((n, l) => n + (l.s2s?.length ?? 0), 0);
  if (segs < 100) throw new Error(`僅 ${segs} 段`);
  console.log(`✓ 站間 ${segs} 段`);
  ok++;
} catch (e) { console.log(`::warning::TRTC 站間時間失敗：${e.message}`); }

/* ── 轉乘步行時間 ── */
try {
  await nap();
  const raw = await get("LineTransfer/TRTC");
  sample("轉乘", raw);
  for (const x of raw) {
    // 實測 TransferDescription 北捷 34 組全為空字串（欄位存在但未填），仍容錯保留
    const rv = x.TransferDescription;
    const desc = String((typeof rv === "string" ? rv : rv?.Zh_tw ?? rv?.zh_tw
      ?? (Array.isArray(rv) ? rv.filter(Boolean).join("；") : "")) ?? "").trim();
    data.transfers.push([
      x.FromStationID, x.ToStationID,
      x.FromLineID ?? "", x.ToLineID ?? "",
      Math.round((x.TransferTime ?? 3) * 10) / 10, // 分鐘
      desc, // 官方動線描述（若未來補填即自動顯示）
      x.IsOnSiteTransfer == null ? 1 : x.IsOnSiteTransfer ? 1 : 0, // 站內 1／站外 0
    ]);
  }
  if (data.transfers.length < 10) throw new Error(`僅 ${data.transfers.length} 組`);
  console.log(`✓ 轉乘 ${data.transfers.length} 組（描述 ${data.transfers.filter((x) => x[5]).length}、站外 ${data.transfers.filter((x) => !x[6]).length}）`);
  ok++;
} catch (e) { console.log(`::warning::TRTC 轉乘失敗：${e.message}`); }

/* ── 班距（分平日/假日、時段） ── */
try {
  await nap();
  const raw = await get("Frequency/TRTC");
  sample("班距", raw);
  for (const f of raw) {
    const svc = f.ServiceDay ?? {};
    const days = [svc.Monday, svc.Tuesday, svc.Wednesday, svc.Thursday, svc.Friday, svc.Saturday, svc.Sunday]
      .map((v) => (v ? 1 : 0));
    for (const h of f.Headways ?? []) {
      data.freq.push([
        f.LineID ?? "", days.join(""),
        h.StartTime ?? "", h.EndTime ?? "",
        Math.round(((h.MinHeadwayMins ?? h.MaxHeadwayMins ?? 6) + (h.MaxHeadwayMins ?? h.MinHeadwayMins ?? 6)) / 2 * 10) / 10,
      ]);
    }
  }
  if (data.freq.length < 20) throw new Error(`僅 ${data.freq.length} 筆`);
  console.log(`✓ 班距 ${data.freq.length} 筆`);
  ok++;
} catch (e) { console.log(`::warning::TRTC 班距失敗：${e.message}`); }

/* ── 首末班車 ── */
try {
  await nap();
  const raw = await get("FirstLastTimetable/TRTC");
  sample("首末班", raw);
  for (const x of raw) {
    const sid = x.StationID;
    (data.firstLast[sid] ??= []).push([
      x.LineID ?? "", x.TripHeadSign ?? x.DestinationStaionID ?? x.DestinationStationID ?? "",
      x.FirstTrainTime ?? "", x.LastTrainTime ?? "",
      [x.ServiceDay?.Monday, x.ServiceDay?.Tuesday, x.ServiceDay?.Wednesday, x.ServiceDay?.Thursday,
       x.ServiceDay?.Friday, x.ServiceDay?.Saturday, x.ServiceDay?.Sunday].map((v) => (v ? 1 : 0)).join(""),
    ]);
  }
  if (Object.keys(data.firstLast).length < 80) throw new Error(`僅 ${Object.keys(data.firstLast).length} 站`);
  console.log(`✓ 首末班 ${Object.keys(data.firstLast).length} 站`);
  ok++;
} catch (e) { console.log(`::warning::TRTC 首末班失敗：${e.message}`); }

if (ok >= 5) {
  out("trtc.json", data);
  console.log(`已寫入 data/trtc.json（${ok}/6 區塊成功）`);
} else {
  console.log(`::warning::成功區塊過少（${ok}/6），不寫 trtc.json`);
}

/* ── 全 OD 票價（獨立檔，較大） ── */
try {
  await nap();
  const raw = await get("ODFare/TRTC");
  sample("票價", raw);
  const pairs = {};
  for (const r of raw) {
    const o = r.OriginStationID, d = r.DestinationStationID;
    const fare = (r.Fares ?? []).find((f) => f.TicketType === 1 && f.FareClass === 1)
      ?? (r.Fares ?? []).find((f) => /全票|Adult/i.test(`${f.FareClassName ?? ""}${f.TicketTypeName ?? ""}`))
      ?? (r.Fares ?? [])[0];
    if (o && d && fare?.Price != null) pairs[`${o}|${d}`] = fare.Price;
  }
  if (Object.keys(pairs).length < 5000) throw new Error(`僅 ${Object.keys(pairs).length} 組`);
  out("trtc-fares.json", { updated: stamp, pairs });
  console.log(`✓ 票價 ${Object.keys(pairs).length} 組`);
} catch (e) { console.log(`::warning::TRTC 票價失敗：${e.message}`); }
