#!/usr/bin/env node
/**
 * 把 TDX 桃捷「各站時刻表」(StationTimeTable) 串連成逐班車時刻，輸出 data/timetable.json。
 * 用法：node scripts/tdx-to-timetable.mjs
 *
 * 原理：TDX 提供的是「每站、每方向、每車種」的發車時刻清單；本script以
 * 站間行駛時間（S2STravelTime，缺漏時用 patterns.json 推估值）沿路線逐站
 * 做單調時間匹配，把同一班車在各站的時刻串成一條 trip，才能供轉乘引擎
 * 判斷「留在車上不用轉乘緩衝」。驗證不過會直接失敗、不寫檔。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chainEvents } from "./lib/chain.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = join(root, "data/raw/tdx");
const network = JSON.parse(readFileSync(join(root, "data/network.json"), "utf8"));
const patterns = JSON.parse(readFileSync(join(root, "data/patterns.json"), "utf8"));

const order = network.stations.map((s) => s.id);
const idx = new Map(order.map((id, i) => [id, i]));
const norm = (id) => (id === "A14A" ? "A14a" : id); // TDX 大小寫防呆

function loadRaw(name) {
  const p = join(rawDir, `${name}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}
const stt = loadRaw("StationTimeTable");
if (!stt || !Array.isArray(stt) || !stt.length) {
  console.error("缺 data/raw/tdx/StationTimeTable.json，請先跑 scripts/fetch-tdx.mjs");
  process.exit(1);
}
const s2s = loadRaw("S2STravelTime");

const toMin = (hm) => {
  const [h, m] = hm.split(":").map(Number);
  const t = h * 60 + m;
  return t < 180 ? t + 1440 : t; // 凌晨 3 點前視為前一營運日的深夜班次
};

/* ---------- 站間行駛分鐘（優先 TDX S2S，缺漏用 patterns 推估） ---------- */
const segMin = new Map(); // "A1>A2" -> 分鐘（含停站）
if (Array.isArray(s2s)) {
  for (const line of s2s) {
    for (const t of line.TravelTimes ?? []) {
      const a = norm(t.FromStationID), b = norm(t.ToStationID);
      const min = ((t.RunTime ?? 0) + (t.StopTime ?? t.DwellTime ?? 0)) / 60;
      if (min > 0) { segMin.set(`${a}>${b}`, min); segMin.set(`${b}>${a}`, min); }
    }
  }
}
const cumLocal = patterns.cumulativeMinutes.local;
const cumExpress = patterns.cumulativeMinutes.express;
function runBetween(type, a, b) {
  // 直達車優先用直達車的推估區間時間（跳站行駛比普通車快很多）
  if (type === "express" && a in cumExpress && b in cumExpress) {
    return Math.abs(cumExpress[b] - cumExpress[a]);
  }
  // a、b 可能相隔多站：逐段累加（優先 TDX S2S 實際值）
  const ia = idx.get(a), ib = idx.get(b);
  const step = ia < ib ? 1 : -1;
  let sum = 0;
  for (let i = ia; i !== ib; i += step) {
    const x = order[i], y = order[i + step];
    sum += segMin.get(`${x}>${y}`) ?? Math.abs(cumLocal[y] - cumLocal[x]);
  }
  return sum;
}

/* ---------- 整理各站發車事件 ---------- */
// TDX 桃捷 TrainType：1=普通車、2=直達車（防禦式判讀，缺欄位時當普通車）
function typeOf(rec) {
  const t = rec.TrainType;
  if (t === 2 || t === "2") return "express";
  if (typeof rec.TripHeadSign === "string" && rec.TripHeadSign.includes("直達")) return "express";
  return "local";
}
function destOf(rec) {
  return norm(rec.DestinationStationID ?? rec.DestinationStaionID ?? "");
}
function dirOf(rec) {
  const from = norm(rec.StationID), dest = destOf(rec);
  if (idx.has(dest) && idx.has(from) && dest !== from) return idx.get(dest) > idx.get(from) ? "S" : "N";
  return rec.Direction === 0 ? "S" : "N"; // TDX: 0=去程(往老街溪)、1=返程(往台北)
}
function dayTypesOf(rec) {
  const d = rec.ServiceDay ?? {};
  const out = [];
  if (d.Monday || d.Tuesday || d.Wednesday || d.Thursday || d.Friday) out.push("weekday");
  if (d.Saturday || d.Sunday || d.NationalHolidays) out.push("holiday");
  return out.length ? out : ["weekday", "holiday"];
}

// events[dayType][dir][type][stationId] = [{t, dest}]，依時間排序
const events = { weekday: {}, holiday: {} };
for (const rec of stt) {
  const sid = norm(rec.StationID);
  if (!idx.has(sid)) continue;
  const type = typeOf(rec);
  const dir = dirOf(rec);
  for (const day of dayTypesOf(rec)) {
    for (const tt of rec.Timetables ?? []) {
      const hm = tt.DepartureTime || tt.ArrivalTime;
      if (!hm) continue;
      const bucket = ((events[day][dir] ??= {})[type] ??= {});
      (bucket[sid] ??= []).push({ t: toMin(hm), dest: destOf(rec) });
    }
  }
}

/* ---------- 沿路線做單調對齊，串成逐班車（共用 lib/chain.mjs） ---------- */
const TERMINALS = { S: new Set(["A13", "A21", "A22"]), N: new Set(["A12", "A1"]) };
const ORIGINS = new Set(["A1", "A13", "A21", "A22"]); // 常見中途始發站

function chain(day, dir, type, byStation) {
  const seqAll = dir === "S" ? order : [...order].reverse();
  const chained = chainEvents({
    byStation: new Map(Object.entries(byStation)),
    seqAll,
    terminals: TERMINALS[dir],
    origins: ORIGINS,
    runBetween: (a, b) => runBetween(type, a, b),
    lineIndex: (id) => idx.get(id),
    maxTerminalGap: type === "express" ? 8 : 2,
  });
  return chained.map((tr) => {
    const dep = Math.round(tr.stops[0][1]);
    const hh = String(Math.floor(dep / 60) % 24).padStart(2, "0");
    const mm = String(dep % 60).padStart(2, "0");
    return {
      id: `${dir}-${type === "express" ? "EXP" : "LOC"}-${hh}${mm}-${tr.stops[0][0]}`,
      type, dir, stops: tr.stops,
    };
  });
}

const dayTypes = {};
for (const day of ["weekday", "holiday"]) {
  const trains = [];
  for (const dir of ["S", "N"]) {
    for (const type of ["local", "express"]) {
      const byStation = events[day]?.[dir]?.[type];
      if (!byStation) continue;
      trains.push(...chain(day, dir, type, byStation));
    }
  }
  trains.sort((a, b) => a.stops[0][1] - b.stops[0][1] || a.id.localeCompare(b.id));
  dayTypes[day] = trains;
}

/* ---------- 驗證（不過就不寫檔） ---------- */
const problems = [];
for (const [day, trains] of Object.entries(dayTypes)) {
  if (trains.length < 120) problems.push(`${day} 只串出 ${trains.length} 班（<120，疑似資料不完整）`);
  for (const t of trains) {
    for (let i = 1; i < t.stops.length; i++) {
      if (t.stops[i][1] <= t.stops[i - 1][1]) {
        problems.push(`${day}/${t.id} 時刻未遞增 @${t.stops[i][0]}`);
        break;
      }
    }
  }
  const expS = trains.filter((t) => t.type === "express" && t.dir === "S" && t.stops.some(([id]) => id === "A13"));
  if (!expS.length) problems.push(`${day} 沒有任何南下直達車停 A13`);
  const avgStops = trains.reduce((s, t) => s + t.stops.length, 0) / trains.length;
  if (avgStops < 6) problems.push(`${day} 平均每班僅 ${avgStops.toFixed(1)} 站（串連疑似失敗）`);
  console.log(`${day}: ${trains.length} 班，平均 ${avgStops.toFixed(1)} 站/班，直達南下 ${expS.length} 班`);
}
if (problems.length) {
  console.error("驗證失敗，不覆蓋 timetable.json：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const meta = loadRaw("meta");
const out = {
  version: `tdx-${(meta?.fetchedAt ?? new Date().toISOString()).slice(0, 10)}`,
  dataStatus: "official",
  sourceNote: "TDX 運輸資料流通服務・桃園捷運各站時刻表（StationTimeTable）串連而成",
  generatedAt: new Date().toISOString(),
  dayTypes,
};
writeFileSync(join(root, "data/timetable.json"), JSON.stringify(out));
console.log("已寫入 data/timetable.json（official）");
