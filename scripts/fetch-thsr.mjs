#!/usr/bin/env node
/**
 * 抓取 TDX 高鐵資料 → 靜態 JSON（使用者只讀本站檔案，不碰 TDX）：
 * - data/thsr-stations.json   車站（含座標，變動極少，每次覆寫無妨）
 * - data/thsr-timetable.json  今明兩日逐班時刻
 * - data/thsr-fares.json      全 OD 票價（標準對號）
 * - data/thsr-live.json       各站即時剩餘座位（充足/有限/售完）
 * - data/alerts.json          高鐵＋桃捷營運通阻
 * 各區塊獨立 try：任何一塊失敗只警告，成功的照寫。
 * 用法：node scripts/fetch-thsr.mjs（需 TDX_CLIENT_ID/TDX_CLIENT_SECRET）
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = (f, obj) => writeFileSync(join(root, "data", f), JSON.stringify(obj));

const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
if (!id || !secret) { console.error("缺 TDX 金鑰"); process.exit(1); }
const tokRes = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
});
if (!tokRes.ok) { console.error(`token 失敗 ${tokRes.status}`); process.exit(1); }
const token = (await tokRes.json()).access_token;

const BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
    if (r.status === 429 && i < 2) { console.log("  （限流，65 秒後重試）"); await sleep(65000); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split("/v2/")[1]?.split("?")[0]}`);
    return r.json();
  }
}

const nowTW = new Date(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(" ", "T"));
const today = nowTW.toISOString().slice(0, 10);
const tomorrow = new Date(nowTW.getTime() + 86400000).toISOString().slice(0, 10);
const stamp = nowTW.toISOString().slice(0, 16).replace("T", " ");

/* ── 車站 ── */
let stations = null;
try {
  const raw = await get(`${BASE}/THSR/Station?%24format=JSON`);
  stations = raw.map((s) => ({
    id: s.StationID,
    zh: s.StationName?.Zh_tw ?? "",
    en: s.StationName?.En ?? "",
    lat: s.StationPosition?.PositionLat ?? null,
    lon: s.StationPosition?.PositionLon ?? null,
  })).sort((a, b) => a.id.localeCompare(b.id));
  if (stations.length < 10) throw new Error(`僅 ${stations.length} 站`);
  out("thsr-stations.json", { updated: stamp, stations });
  console.log(`✓ 車站 ${stations.length} 站`);
} catch (e) { console.log(`::warning::高鐵車站未更新：${e.message}`); }

/* ── 今明兩日逐班時刻 ── */
try {
  await sleep(1200);
  const days = {};
  for (const d of [today, tomorrow]) {
    const raw = await get(`${BASE}/THSR/DailyTimetable/TrainDate/${d}?%24format=JSON`);
    days[d] = raw.map((t) => ({
      no: t.DailyTrainInfo?.TrainNo ?? "",
      dir: t.DailyTrainInfo?.Direction ?? 0, // 0=南下 1=北上
      stops: (t.StopTimes ?? []).map((s) => [s.StationID, s.DepartureTime || s.ArrivalTime, s.ArrivalTime || s.DepartureTime]),
    })).filter((t) => t.no && t.stops.length >= 2);
    if (days[d].length < 50) throw new Error(`${d} 僅 ${days[d].length} 班`);
    await sleep(1200);
  }
  out("thsr-timetable.json", { updated: stamp, days });
  console.log(`✓ 時刻表 ${today} ${days[today].length} 班／${tomorrow} ${days[tomorrow].length} 班`);
} catch (e) { console.log(`::warning::高鐵時刻表未更新：${e.message}`); }

/* ── 全 OD 票價（標準廂對號） ── */
try {
  await sleep(1200);
  const raw = await get(`${BASE}/THSR/ODFare?%24format=JSON`);
  const pairs = {};
  for (const r of raw) {
    const o = r.OriginStationID, d = r.DestinationStationID;
    const fare = (r.Fares ?? []).find((f) => f.TicketType === 1 && f.FareClass === 1 && f.CabinClass === 1)
      ?? (r.Fares ?? []).find((f) => /標準|Standard/i.test(`${f.CabinClassName ?? ""}${f.TicketTypeName ?? ""}`))
      ?? (r.Fares ?? [])[0];
    if (o && d && fare?.Price != null) pairs[`${o}|${d}`] = fare.Price;
  }
  if (Object.keys(pairs).length < 100) throw new Error(`僅 ${Object.keys(pairs).length} 組`);
  out("thsr-fares.json", { updated: stamp, pairs });
  console.log(`✓ 票價 ${Object.keys(pairs).length} 組`);
} catch (e) { console.log(`::warning::高鐵票價未更新：${e.message}`); }

/* ── 各站即時剩餘座位 ── */
try {
  const ids = stations?.map((s) => s.id)
    ?? (existsSync(join(root, "data/thsr-stations.json"))
      ? JSON.parse(readFileSync(join(root, "data/thsr-stations.json"), "utf8")).stations.map((s) => s.id)
      : []);
  if (!ids.length) throw new Error("無車站清單");
  const seat = {};
  // 狀態壓縮：O=充足 L=有限 X=售完
  const code = (v) => (/avail|^O$/i.test(v ?? "") ? "O" : /limit|^L$/i.test(v ?? "") ? "L" : /full|^X$/i.test(v ?? "") ? "X" : "");
  let logged = false;
  for (const sid of ids) {
    await sleep(5000); // 12 站連續呼叫會撞 TDX 突發限流（罰 65 秒），拉開間隔更省時
    let raw;
    try { raw = await get(`${BASE}/THSR/AvailableSeatStatusList/Station/${sid}?%24format=JSON`); }
    catch { raw = await get(`${BASE}/THSR/AvailableSeatStatusList/${sid}?%24format=JSON`); }
    const item = Array.isArray(raw) ? raw[0] : raw;
    const list = item?.AvailableSeats ?? item?.AvailableSeatStatusList ?? (Array.isArray(raw) ? raw : []);
    if (!logged && list[0]) {
      console.log("餘票首筆欄位:", Object.keys(list[0]).join(","));
      console.log("餘票首筆樣本:", JSON.stringify(list[0]).slice(0, 500));
      logged = true;
    }
    for (const s of list) {
      const no = s.TrainNo ?? s.DailyTrainInfo?.TrainNo;
      if (!no) continue;
      // 逐站餘票：StopStations = 由查詢站搭到各後續停靠站的狀態
      const stops = s.StopStations ?? s.StopStation ?? [];
      (seat[sid] ??= {})[no] = stops.length
        ? stops.map((x) => [x.StationID ?? x.NextStationID ?? "", code(x.StandardSeatStatus), code(x.BusinessSeatStatus)])
        : [["*", code(s.StandardSeatStatus), code(s.BusinessSeatStatus)]];
    }
  }
  if (!Object.keys(seat).length) throw new Error("無餘票資料");
  // 品質訊號：有多少筆帶有效狀態碼（全空代表欄位對映失效）
  let withStatus = 0, total = 0;
  for (const trains of Object.values(seat)) for (const ent of Object.values(trains)) {
    total++;
    if (ent.some((e) => e[1] || e[2])) withStatus++;
  }
  if (!withStatus) console.log("::warning::餘票狀態值全空，欄位對映可能失效");
  out("thsr-live.json", { updated: stamp, seat });
  console.log(`✓ 餘票 ${Object.keys(seat).length} 站（${withStatus}/${total} 筆含狀態值）`);
} catch (e) { console.log(`::warning::高鐵餘票未更新：${e.message}`); }

/* ── 營運通阻（高鐵＋桃捷） ── */
try {
  await sleep(1200);
  const alerts = [];
  for (const [sys, url] of [["THSR", `${BASE}/THSR/AlertInfo?%24format=JSON`], ["TYMC", `${BASE}/Metro/Alert/TYMC?%24format=JSON`]]) {
    try {
      const raw = await get(url);
      const list = Array.isArray(raw) ? raw : raw?.Alerts ?? [];
      for (const a of list) {
        const title = a.Title ?? a.AlertTitle ?? "";
        const desc = a.Description ?? a.AlertDescription ?? "";
        const status = a.Status ?? a.AlertStatus;
        // 高鐵 AlertInfo 平時會回「系統正常」類訊息（Status 1 / Level 1），僅保留異常
        if (/正常|normal/i.test(`${title}${desc}`) || status === 1) continue;
        if (!title && !desc) continue;
        alerts.push({ sys, title: title || desc.slice(0, 40), desc: desc.slice(0, 200) });
      }
      await sleep(1200);
    } catch (e) { console.log(`（${sys} 警示端點：${e.message}）`); }
  }
  out("alerts.json", { updated: stamp, alerts });
  console.log(`✓ 警示 ${alerts.length} 則`);
} catch (e) { console.log(`::warning::警示未更新：${e.message}`); }
