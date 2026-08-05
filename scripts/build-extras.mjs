#!/usr/bin/env node
/**
 * 把 .tdx-extras/ 的原始資料轉成網站用的精簡檔：
 *   - data/fares.json：{"pairs": {"A1|A16": 145, ...}}（全票單程）
 *   - data/hsr-a18.json：高鐵桃園站發車清單 {trains:[{dep,dir,to:{zh,en},days[7]}]}
 * 驗證不過就不寫該檔。用法：node scripts/build-extras.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const inDir = join(root, ".tdx-extras");
const load = (n) => {
  const p = join(inDir, `${n}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const norm = (id) => (id === "A14A" ? "A14a" : id);
const updated = new Date().toISOString().slice(0, 10);
let wrote = 0;

/* ---------- 票價 ---------- */
const od = load("ODFare");
if (Array.isArray(od) && od.length) {
  const pairs = {};
  for (const rec of od) {
    const o = norm(rec.OriginStationID), d = norm(rec.DestinationStationID);
    const fares = rec.Fares ?? [];
    const pick = fares.find((f) => (f.TicketType === 1 || f.TicketType === "1") && (f.FareClass === 1 || f.FareClass === "1")) ?? fares[0];
    const price = pick?.Price;
    if (o && d && typeof price === "number" && price > 0) pairs[`${o}|${d}`] = price;
  }
  const n = Object.keys(pairs).length;
  const prices = Object.values(pairs);
  if (n >= 400 && Math.min(...prices) >= 5 && Math.max(...prices) <= 300) {
    writeFileSync(join(root, "data/fares.json"), JSON.stringify({ updated, pairs }));
    console.log(`✓ fares.json：${n} 組票價`);
    wrote++;
  } else {
    console.error(`✗ 票價驗證不過（${n} 組，區間 ${Math.min(...prices)}–${Math.max(...prices)}）`);
    console.error("  範例:", JSON.stringify(od[0]).slice(0, 400));
  }
} else console.log("（無 ODFare 原始資料，略過票價）");

/* ---------- 高鐵桃園站發車 ---------- */
const thsrSta = load("THSR_Station");
const thsrTt = load("THSR_GeneralTimetable");
if (Array.isArray(thsrSta) && Array.isArray(thsrTt) && thsrTt.length) {
  const tao = thsrSta.find((s) => (s.StationName?.Zh_tw ?? "").includes("桃園"));
  if (!tao) {
    console.error("✗ 找不到高鐵桃園站；站名樣本:", thsrSta.slice(0, 3).map((s) => s.StationName?.Zh_tw).join("/"));
  } else {
    const trains = [];
    for (const rec of thsrTt) {
      const g = rec.GeneralTimetable ?? rec;
      const info = g.GeneralTrainInfo ?? g;
      const stop = (g.StopTimes ?? []).find((st) => st.StationID === tao.StationID);
      const dep = stop?.DepartureTime || stop?.ArrivalTime;
      if (!dep) continue;
      const sd = g.ServiceDay ?? {};
      trains.push({
        dep,
        dir: Number(info.Direction ?? 0),
        to: { zh: info.EndingStationName?.Zh_tw ?? "", en: info.EndingStationName?.En ?? "" },
        days: [sd.Monday, sd.Tuesday, sd.Wednesday, sd.Thursday, sd.Friday, sd.Saturday, sd.Sunday].map(Boolean),
      });
    }
    trains.sort((a, b) => a.dep.localeCompare(b.dep));
    if (trains.length >= 60) {
      writeFileSync(join(root, "data/hsr-a18.json"), JSON.stringify({ updated, station: tao.StationID, trains }));
      console.log(`✓ hsr-a18.json：${trains.length} 班停靠高鐵桃園站`);
      wrote++;
    } else {
      console.error(`✗ 高鐵驗證不過（僅 ${trains.length} 班）`);
      console.error("  範例:", JSON.stringify(thsrTt[0]).slice(0, 500));
    }
  }
} else console.log("（無 THSR 原始資料，略過高鐵接駁）");

console.log(`完成：寫入 ${wrote} 檔`);
