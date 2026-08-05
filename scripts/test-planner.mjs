#!/usr/bin/env node
/** 轉乘引擎情境測試：node scripts/test-planner.mjs */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, planJourney, planDirect, planOptions, fmtTime } from "../assets/planner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const network = JSON.parse(readFileSync(join(root, "data/network.json"), "utf8"));
const timetable = JSON.parse(readFileSync(join(root, "data/timetable.json"), "utf8"));
const name = Object.fromEntries(network.stations.map((s) => [s.id, s.name]));

const index = buildIndex(network, timetable, "weekday");

function show(label, j) {
  if (!j) return console.log(`  ${label}: （無班次）`);
  const legs = j.legs
    .map((l) => `${l.type === "express" ? "直達" : "普通"} ${name[l.from]}${fmtTime(l.dep)} → ${name[l.to]}${fmtTime(l.arr)}`)
    .join(" ⇄ ");
  console.log(`  ${label}: ${fmtTime(j.dep)}發 ${fmtTime(j.arr)}到（${Math.round(j.arr - j.dep)}分, 轉乘${j.transfers}次） ${legs}`);
}

let failures = 0;
function expect(cond, msg) {
  if (!cond) { failures++; console.log(`  ❌ ${msg}`); }
  else console.log(`  ✅ ${msg}`);
}

console.log("\n▍案例1：台北車站 → 橫山（A16），12:10 出發");
const j1 = planJourney(index, { from: "A1", to: "A16", departAfter: 730 });
const d1 = planDirect(index, { from: "A1", to: "A16", departAfter: 730 });
show("最快", j1); show("免轉乘", d1);
expect(j1 && j1.arr <= d1.arr, "最快方案不晚於免轉乘方案");

console.log("\n▍案例2：台北車站 → 坑口（A11），12:10 出發（預期可經 A12 折返）");
const j2 = planJourney(index, { from: "A1", to: "A11", departAfter: 730 });
const d2 = planDirect(index, { from: "A1", to: "A11", departAfter: 730 });
show("最快", j2); show("免轉乘", d2);
expect(j2 && j2.arr <= d2.arr, "最快方案不晚於免轉乘方案");

console.log("\n▍案例3：橫山 → 台北車站，08:05 出發（預期普通車轉北上直達）");
const j3 = planJourney(index, { from: "A16", to: "A1", departAfter: 485 });
const d3 = planDirect(index, { from: "A16", to: "A1", departAfter: 485 });
show("最快", j3); show("免轉乘", d3);
expect(j3 && j3.arr <= d3.arr, "最快方案不晚於免轉乘方案");

console.log("\n▍案例4：台北車站 → 長庚醫院，09:00 出發（預期直達車免轉乘）");
const j4 = planJourney(index, { from: "A1", to: "A8", departAfter: 540 });
show("最快", j4);
expect(j4 && j4.transfers === 0 && j4.legs[0].type === "express", "直達車一段到底");

console.log("\n▍案例5：接續方案 台北車站 → 老街溪，18:00 出發");
for (const o of planOptions(index, { from: "A1", to: "A22", departAfter: 1080, count: 4 })) show("方案", o);

console.log("\n▍案例6：深夜 台北車站 → 老街溪，23:20 出發（預期當日到不了）");
const j6 = planJourney(index, { from: "A1", to: "A22", departAfter: 1400 });
show("結果", j6);
expect(j6 === null || j6.arr >= 1440, "深夜查詢：回報無班次或跨午夜抵達");

console.log("\n▍案例7：機場第二航廈 → 台北車站，21:03 出發");
const j7 = planJourney(index, { from: "A13", to: "A1", departAfter: 1263 });
show("最快", j7);

console.log(failures ? `\n${failures} 項檢查失敗` : "\n全部通過");
process.exit(failures ? 1 : 0);
