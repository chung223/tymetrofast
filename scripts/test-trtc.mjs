#!/usr/bin/env node
/** 北捷班距引擎測試：兩線一轉乘的固定樣本，驗證路徑、轉乘與等車推估。 */
import { buildTrtcGraph, planTrtc, headwayOf } from "../assets/trtc-engine.mjs";

// BL 線：BL1–BL2–BL3；R 線：R1–R2–R3；BL2=R2 為同體轉乘站（步行 2 分）
const data = {
  lines: {
    BL: { stations: ["BL1", "BL2", "BL3"], s2s: [["BL1", "BL2", 2], ["BL2", "BL3", 3]] },
    R: { stations: ["R1", "R2", "R3"], s2s: [["R1", "R2", 2.5], ["R2", "R3", 2]] },
  },
  transfers: [
    ["BL2", "R2", "BL", "R", 2],
    ["R2", "BL2", "R", "BL", 2],
  ],
  freq: [
    ["BL", "1111100", "06:00", "09:00", 4],
    ["BL", "1111100", "09:00", "23:00", 6],
    ["R", "1111100", "06:00", "23:00", 8],
    ["BL", "0000011", "06:00", "23:00", 10],
    ["R", "0000011", "06:00", "23:00", 10],
  ],
};

let fail = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? `（${extra}）` : ""}`);
  if (!cond) fail++;
};

const g = buildTrtcGraph(data);

// 班距查表
ok("尖峰班距 4 分", headwayOf(data, "BL", 8 * 60, false) === 4);
ok("離峰班距 6 分", headwayOf(data, "BL", 10 * 60, false) === 6);
ok("假日班距 10 分", headwayOf(data, "BL", 10 * 60, true) === 10);

// 同線直達：BL1→BL3 = 等 2 + 乘 5
const a = planTrtc(data, g, { from: "BL1", to: "BL3", min: 8 * 60, holiday: false });
ok("同線直達", a && a.transfers === 0 && a.legs.length === 1, JSON.stringify(a));
ok("直達總時間 7 分", a && a.totalMin === 7, `got ${a?.totalMin}`);
ok("直達段乘車 5 分", a && Math.abs(a.legs[0].rideMin - 5) < 0.2, `got ${a?.legs[0].rideMin}`);

// 跨線轉乘：BL1→R3 = 等2 + 乘2(BL1→BL2) + 走2 + 等4(R 班距8/2) + 乘2(R2→R3) = 12
const b = planTrtc(data, g, { from: "BL1", to: "R3", min: 8 * 60, holiday: false });
ok("跨線一轉", b && b.transfers === 1 && b.legs.length === 2, JSON.stringify(b));
ok("轉乘總時間 12 分", b && b.totalMin === 12, `got ${b?.totalMin}`);
ok("第二段等車 4 分", b && b.legs[1].waitMin === 4, `got ${b?.legs[1]?.waitMin}`);
ok("第二段步行 2 分", b && b.legs[1].walkMin === 2, `got ${b?.legs[1]?.walkMin}`);

// 起訖相同／查無站
ok("起訖相同回 null", planTrtc(data, g, { from: "BL1", to: "BL1", min: 480, holiday: false }) === null);
ok("查無站回 null", planTrtc(data, g, { from: "BL1", to: "X9", min: 480, holiday: false }) === null);

console.log(fail ? `\n${fail} 項失敗` : "\n全部通過");
process.exit(fail ? 1 : 0);
