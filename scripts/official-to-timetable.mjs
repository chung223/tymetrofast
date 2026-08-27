#!/usr/bin/env node
/**
 * 解析桃捷官網「各站時刻表」頁面（data/raw/official/{weekday,holiday}/timetable-*.html），
 * 依車種（des01 直達車、des02 尖峰增停直達車、des03 普通車、des04 增開機場班次、
 * des05 尖峰跳站普通車…以頁面標注為準）分組，串連成逐班車時刻，輸出 data/timetable.json。
 * 用法：node scripts/official-to-timetable.mjs [--dry-run]
 * 驗證不過會直接失敗、不寫檔。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chainEvents } from "./lib/chain.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawRoot = join(root, "data/raw/official");
const network = JSON.parse(readFileSync(join(root, "data/network.json"), "utf8"));
const patterns = JSON.parse(readFileSync(join(root, "data/patterns.json"), "utf8"));
const dryRun = process.argv.includes("--dry-run");

const order = network.stations.map((s) => s.id);
const idx = new Map(order.map((id, i) => [id, i]));
const cumLocal = patterns.cumulativeMinutes.local;
const cumExpress = patterns.cumulativeMinutes.express;

const TERMINALS = { S: new Set(["A13", "A21", "A22"]), N: new Set(["A12", "A1"]) };
// 官網把同一班車在不同站標成不同車種（例：尖峰增停直達車在 A13 標 des01、在 A3 標 des02），
// 逐車種各自串連就會把一班車拆成好幾段殘骸。改為先依「停站型態家族」串連，再回頭標車種。
const EXPRESS_CLS = new Set(["des01", "des02"]);
const FAMILY_OF = (cls) => (EXPRESS_CLS.has(cls) ? "express" : "local");
const RANK_MAP = { des03: 0, des04: 1, des01: 0, des02: 1, des05: 2 };
const RANK = (cls) => RANK_MAP[cls] ?? 0;
// 普通車的合法始發站；自其他站「憑空出現」代表它跳過了上游各站
const LOCAL_ORIGINS = new Set(["A1", "A12", "A13", "A21", "A22"]);
const clsAt = new Map(); // `${dir}|${station}|${t}` -> 最特殊的車種標記
const ORIGINS = new Set(["A1", "A13", "A21", "A22"]);

function runBetweenFor(isExpress) {
  return (a, b) => {
    if (isExpress && a in cumExpress && b in cumExpress) return Math.abs(cumExpress[b] - cumExpress[a]);
    return Math.abs(cumLocal[b] - cumLocal[a]);
  };
}

const toMin = (hh, mm) => {
  const t = hh * 60 + mm;
  return t < 180 ? t + 1440 : t;
};

/* ---------- 解析單一車站頁面 ---------- */
function parsePage(html, stationId) {
  const events = []; // {dir, cls, t}
  const tableRe = /<table[^>]*class="time-table"[\s\S]*?<\/table>/g;
  for (const m of html.matchAll(tableRe)) {
    const table = m[0];
    const bodyMatch = table.match(/<tbody class="(up|down)">/);
    if (!bodyMatch) continue;
    const dir = bodyMatch[1] === "up" ? "N" : "S";
    for (const row of table.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
      const hourM = row.match(/<th scope="row">(\d{1,2})<\/th>/);
      if (!hourM) continue;
      const hh = Number(hourM[1]);
      for (const cell of row.matchAll(/<span class="downspan (des\d+)"><i>(\d{1,2})<\/i><\/span>/g)) {
        events.push({ dir, cls: cell[1], t: toMin(hh, Number(cell[2])), station: stationId });
      }
    }
  }
  return events;
}

/* ---------- 讀取各日別頁面 ---------- */
const clsDesc = new Map(); // desXX -> 描述文字
const dayTypes = {};
const stats = [];
for (const day of ["weekday", "holiday"]) {
  const dir = join(rawRoot, day);
  if (!existsSync(dir)) {
    console.error(`缺 ${dir}（需先跑 scripts/fetch-official-site.sh 抓平日與假日兩份）`);
    process.exit(1);
  }
  const files = readdirSync(dir).filter((f) => /^timetable-A\d+a?\.html$/.test(f));
  if (files.length < 20) {
    console.error(`${day} 僅 ${files.length} 個車站頁（<20，疑似抓取不完整）`);
    process.exit(1);
  }

  // events[dir][cls] = Map(station -> [{t}])
  const buckets = { S: new Map(), N: new Map() };
  let totalEvents = 0;
  for (const f of files) {
    const stationId = f.match(/timetable-(A\d+a?)\.html/)[1];
    if (!idx.has(stationId)) continue;
    const html = readFileSync(join(dir, f), "utf8");
    // 車種描述：優先取頁面圖例（<li><span class="desXX">…），輔以事件旁的報讀文字
    for (const m of html.matchAll(/<li><span class="(des\d+)"><i[^>]*>[^<]*<\/i><\/span>(?:<div[^>]*>([^<]*)<\/div>)?\s*([^<]*)<\/li>/g)) {
      const desc = `${m[2] ?? ""}${m[3] ?? ""}`.trim();
      if (desc && !clsDesc.has(m[1])) clsDesc.set(m[1], desc);
    }
    for (const m of html.matchAll(/<span class="downspan (des\d+)"><i>\d{1,2}<\/i><\/span><div class="sr-only sr-only-focusable">([^<]*車[^<]*)<\/div>/g)) {
      if (!clsDesc.has(m[1])) clsDesc.set(m[1], m[2]);
    }
    // 同一張表在頁面上有「視覺版＋報讀版」兩份，以 (方向,車種,站,時刻) 去重
    const seen = new Set();
    for (const ev of parsePage(html, stationId)) {
      const key = `${ev.dir}|${ev.cls}|${ev.station}|${ev.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fam = FAMILY_OF(ev.cls);
      const byStation = buckets[ev.dir].get(fam) ?? new Map();
      if (!buckets[ev.dir].has(fam)) buckets[ev.dir].set(fam, byStation);
      const list = byStation.get(ev.station) ?? byStation.set(ev.station, []).get(ev.station);
      // 併家族後同一格可能來自兩個車種標記，以 (站,時刻) 去重，車種另存供事後標記
      if (!list.some((x) => x.t === ev.t)) list.push({ t: ev.t, dest: null });
      const ck = `${ev.dir}|${ev.station}|${ev.t}`;
      if (!clsAt.has(ck) || RANK(ev.cls) > RANK(clsAt.get(ck))) clsAt.set(ck, ev.cls);
      totalEvents++;
    }
  }

  const trains = [];
  let matchedStops = 0;
  for (const dirKey of ["S", "N"]) {
    const seqAll = dirKey === "S" ? order : [...order].reverse();
    for (const [fam, byStation] of buckets[dirKey]) {
      const isExpress = fam === "express";
      const chained = chainEvents({
        byStation,
        seqAll,
        terminals: TERMINALS[dirKey],
        origins: ORIGINS,
        runBetween: runBetweenFor(isExpress),
        lineIndex: (id) => idx.get(id),
        maxTerminalGap: isExpress ? 8 : 2,
      });
      for (const tr of chained) {
        const dep = Math.round(tr.stops[0][1]);
        const hh = String(Math.floor(dep / 60) % 24).padStart(2, "0");
        const mm = String(dep % 60).padStart(2, "0");
        matchedStops += tr.stops.length;
        // 車種以「串出來的實際停站型態」為準。官網同一班車在不同站可能標成不同
        // 車種（尖峰增停直達車在 A13 標 des01、在 A3 才標 des02），只信標記會錯。
        const ids = tr.stops.map(([id]) => id);
        const marked = new Set(tr.stops.map(([sid, t]) => clsAt.get(`${dirKey}|${sid}|${t}`)).filter(Boolean));
        let cls;
        if (isExpress) {
          cls = ids.some((id) => id === "A18" || id === "A21") ? "des02" : "des01";
        } else {
          // 普通車若非自端點站起始，代表它是一路通過上游站才在此出現＝跳站車
          const gapless = ids.every((id, i) => i === 0 || Math.abs(idx.get(id) - idx.get(ids[i - 1])) === 1);
          cls = gapless && LOCAL_ORIGINS.has(ids[0]) ? (marked.has("des04") ? "des04" : "des03") : "des05";
        }
        trains.push({
          id: `${dirKey}-${isExpress ? "EXP" : "LOC"}-${hh}${mm}-${cls}`,
          type: isExpress ? "express" : "local",
          dir: dirKey,
          cls,
          stops: tr.stops,
        });
      }
    }
  }
  trains.sort((a, b) => a.stops[0][1] - b.stops[0][1] || a.id.localeCompare(b.id));
  dayTypes[day] = trains;
  stats.push({ day, trains: trains.length, totalEvents, matchedStops });
}

/* ---------- 驗證（不過就不寫檔） ---------- */
const problems = [];
for (const { day, trains, totalEvents, matchedStops } of stats) {
  const list = dayTypes[day];
  // 串連涵蓋率：每個事件都應成為某班車的一站（每班車終點到站時刻為額外補上，故扣除班數）
  const coverage = totalEvents ? Math.min((matchedStops - list.length) / totalEvents, 1) : 0;
  if (coverage < 0.97) problems.push(`${day} 事件涵蓋率僅 ${(coverage * 100).toFixed(1)}%（串連疑似失敗）`);
  if (trains < 120) problems.push(`${day} 只串出 ${trains} 班（<120）`);
  for (const t of list) {
    for (let i = 1; i < t.stops.length; i++) {
      if (t.stops[i][1] <= t.stops[i - 1][1]) { problems.push(`${day}/${t.id} 時刻未遞增 @${t.stops[i][0]}`); break; }
    }
  }
  const expS = list.filter((t) => t.type === "express" && t.dir === "S" && t.stops.some(([id]) => id === "A13"));
  if (!expS.length) problems.push(`${day} 沒有南下直達車停 A13`);
  // 車種完整性：官網逐站標記不一致時最容易產生「兩三站的殘骸」，這裡直接擋下
  const frag = list.filter((t) => t.stops.length <= 2);
  if (frag.length > 1) problems.push(`${day} 有 ${frag.length} 班只串出 ≤2 站（${frag.slice(0, 3).map((t) => t.id).join("、")}…）`);
  const d2 = list.filter((t) => t.cls === "des02");
  const d2bad = d2.filter((t) => t.stops.length !== 7);
  if (!d2.length) problems.push(`${day} 沒有尖峰增停直達車（des02）`);
  else if (d2bad.length) problems.push(`${day} 尖峰增停直達車應停 7 站，有 ${d2bad.length} 班不是（${d2bad[0].id} ${d2bad[0].stops.length} 站）`);
  const avg = list.reduce((s, t) => s + t.stops.length, 0) / list.length;
  console.log(`${day}: ${list.length} 班，平均 ${avg.toFixed(1)} 站/班，南下直達 ${expS.length} 班，事件涵蓋率 ${(coverage * 100).toFixed(1)}%`);
}
console.log("車種:", Object.fromEntries(clsDesc));
if (problems.length) {
  console.error("驗證失敗，不覆蓋 timetable.json：");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
if (dryRun) {
  console.log("（--dry-run，不寫檔）");
  process.exit(0);
}

const fetchedAt = existsSync(join(rawRoot, "meta.json"))
  ? JSON.parse(readFileSync(join(rawRoot, "meta.json"), "utf8")).fetchedAt
  : new Date().toISOString();
const out = {
  version: `official-${fetchedAt.slice(0, 10)}`,
  dataStatus: "official",
  sourceNote: "桃園捷運官網各站時刻表解析而成",
  generatedAt: new Date().toISOString(),
  trainClasses: Object.fromEntries(clsDesc),
  dayTypes,
};
writeFileSync(join(root, "data/timetable.json"), JSON.stringify(out));
console.log("已寫入 data/timetable.json（official）");
