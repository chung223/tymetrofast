#!/usr/bin/env node
/**
 * 將 data/patterns.json 的班距模式展開成逐班車時刻 data/timetable.json。
 * 用法：node scripts/build-timetable.mjs
 *
 * 產生邏輯：
 *  1. 依發車帶（start~end 每 headwayMin 分鐘）展開每一班車的起點發車時刻
 *  2. 依 cumulativeMinutes 推算各停靠站時刻（北上由南下區間時間鏡射）
 *  3. 套用待避規則：直達車即將追上的普通車，會在待避站停等直達車通過後再開
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --if-estimate：現有 timetable.json 若已是 TDX 官方資料就不覆蓋（部署流程用）
if (process.argv.includes("--if-estimate")) {
  const p = join(root, "data/timetable.json");
  if (existsSync(p) && JSON.parse(readFileSync(p, "utf8")).dataStatus === "official") {
    console.log("timetable.json 為官方資料（official），略過依 patterns 重建。");
    process.exit(0);
  }
}
const network = JSON.parse(readFileSync(join(root, "data/network.json"), "utf8"));
const patterns = JSON.parse(readFileSync(join(root, "data/patterns.json"), "utf8"));

const order = network.stations.map((s) => s.id);
const idx = new Map(order.map((id, i) => [id, i]));

function parseHM(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

// 各車種在南下方向的累積到站分鐘（僅含該車種停靠站）
const cumS = patterns.cumulativeMinutes;

// 車種停靠站（依路線順序）
const stopsOf = {
  local: order.filter((id) => id in cumS.local),
  express: order.filter((id) => id in cumS.express),
};

// 北上累積分鐘：以南下區間時間鏡射（自 A22 起算）
const cumN = {};
for (const type of ["local", "express"]) {
  const stops = stopsOf[type];
  const last = stops[stops.length - 1];
  cumN[type] = Object.fromEntries(stops.map((id) => [id, cumS[type][last] - cumS[type][id]]));
}

function cumOf(type, dir) {
  return dir === "S" ? cumS[type] : cumN[type];
}

// 直達車「通過」非停靠站的估計時刻（以普通車累積分鐘作為距離比例內插），用於待避計算
function expressPassTime(train, stationId) {
  const stops = train.stops;
  const i = idx.get(stationId);
  for (let k = 0; k < stops.length - 1; k++) {
    const [a, ta] = stops[k];
    const [b, tb] = stops[k + 1];
    const ia = idx.get(a), ib = idx.get(b);
    if ((ia < i && i < ib) || (ib < i && i < ia)) {
      const la = cumS.local[a], lb = cumS.local[b], lx = cumS.local[stationId];
      return ta + (tb - ta) * Math.abs(lx - la) / Math.abs(lb - la);
    }
    if (a === stationId) return ta;
    if (b === stationId) return tb;
  }
  return null;
}

function buildDayType(dayName, dayServices) {
  const trains = [];
  for (const dir of ["S", "N"]) {
    for (const band of dayServices[dir] ?? []) {
      const cum = cumOf(band.type, dir);
      const seq = dir === "S" ? stopsOf[band.type] : [...stopsOf[band.type]].reverse();
      const iFrom = seq.indexOf(band.from);
      const iTo = seq.indexOf(band.to);
      if (iFrom < 0 || iTo < 0 || iFrom >= iTo) {
        throw new Error(`發車帶起訖站不合理: ${JSON.stringify(band)}`);
      }
      const sub = seq.slice(iFrom, iTo + 1);
      const start = parseHM(band.start);
      const end = parseHM(band.end);
      for (let t = start; t <= end + 1e-9; t += band.headwayMin) {
        const dep = Math.round(t);
        const base = cum[band.from];
        const stops = sub.map((id) => [id, dep + cum[id] - base]);
        const hh = String(Math.floor(dep / 60)).padStart(2, "0");
        const mm = String(dep % 60).padStart(2, "0");
        trains.push({
          id: `${dir}-${band.type === "express" ? "EXP" : "LOC"}-${hh}${mm}`,
          type: band.type,
          dir,
          stops,
        });
      }
    }
  }

  // 待避：普通車若將被同方向直達車追上，於待避站停等直達車通過後 0.5 分再開
  let holds = 0;
  for (const dir of ["S", "N"]) {
    const rule = patterns.overtake?.[dir];
    if (!rule) continue;
    const expresses = trains.filter((t) => t.dir === dir && t.type === "express");
    for (const loc of trains.filter((t) => t.dir === dir && t.type === "local")) {
      for (const stationId of rule.stations) {
        const pos = loc.stops.findIndex(([id]) => id === stationId);
        if (pos <= 0 || pos >= loc.stops.length - 1) continue; // 起終點不待避
        const arr = loc.stops[pos][1];
        let passAt = null;
        for (const exp of expresses) {
          const p = expressPassTime(exp, stationId);
          if (p !== null && p >= arr - 1 && p - arr <= rule.maxHoldMin) {
            passAt = passAt === null ? p : Math.min(passAt, p);
          }
        }
        if (passAt !== null) {
          const delta = Math.round((passAt + 0.5 - arr) * 2) / 2;
          if (delta > 0) {
            for (let k = pos + 1; k < loc.stops.length; k++) loc.stops[k][1] += delta;
            holds++;
          }
          break; // 每班普通車最多待避一次
        }
      }
    }
  }

  trains.sort((a, b) => a.stops[0][1] - b.stops[0][1] || a.id.localeCompare(b.id));
  console.log(`  ${dayName}: ${trains.length} 班（含 ${holds} 班待避）`);
  return trains;
}

console.log(`展開班表 v${patterns.version} (${patterns.dataStatus})`);
const dayTypes = {};
for (const [dayName, dayServices] of Object.entries(patterns.services)) {
  dayTypes[dayName] = buildDayType(dayName, dayServices);
}

const out = {
  version: patterns.version,
  dataStatus: patterns.dataStatus,
  sourceNote: patterns.sourceNote,
  generatedAt: new Date().toISOString(),
  dayTypes,
};
writeFileSync(join(root, "data/timetable.json"), JSON.stringify(out));
console.log(`已寫入 data/timetable.json`);
