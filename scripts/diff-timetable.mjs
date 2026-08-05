#!/usr/bin/env node
/**
 * 比對新舊 timetable.json，輸出 Markdown 改點摘要到 stdout。
 * 無實質差異（班次與時刻皆相同）時不輸出任何內容。
 * 用法：node scripts/diff-timetable.mjs old.json new.json
 */
import { readFileSync } from "node:fs";

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error("用法：node scripts/diff-timetable.mjs old.json new.json");
  process.exit(2);
}
const A = JSON.parse(readFileSync(oldPath, "utf8"));
const B = JSON.parse(readFileSync(newPath, "utf8"));

const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.round(m) % 60).padStart(2, "0")}`;
// 以「方向｜車種｜始發站｜始發時刻」當班次識別（id 每次重產會變，不能用）
const key = (t) => `${t.dir}|${t.type}|${t.stops[0][0]}|${fmt(t.stops[0][1])}`;
const desc = (k) => {
  const [dir, type, stn, tm] = k.split("|");
  return `- ${tm} ${stn} 發（${dir === "S" ? "南下" : "北上"}・${type === "express" ? "直達" : "普通"}）`;
};

const lines = [];
for (const day of new Set([...Object.keys(A.dayTypes ?? {}), ...Object.keys(B.dayTypes ?? {})])) {
  const a = A.dayTypes?.[day] ?? [], b = B.dayTypes?.[day] ?? [];
  const mapA = new Map(a.map((t) => [key(t), t]));
  const mapB = new Map(b.map((t) => [key(t), t]));
  const added = [...mapB.keys()].filter((k) => !mapA.has(k));
  const removed = [...mapA.keys()].filter((k) => !mapB.has(k));
  let retimed = 0;
  for (const [k, tb] of mapB) {
    const ta = mapA.get(k);
    if (ta && JSON.stringify(ta.stops) !== JSON.stringify(tb.stops)) retimed++;
  }
  if (!added.length && !removed.length && !retimed && a.length === b.length) continue;

  const dayName = day === "weekday" ? "平日" : day === "holiday" ? "假日" : day;
  lines.push(`### ${dayName}（${a.length} → ${b.length} 班）`, "");
  const show = (arr, label) => {
    if (!arr.length) return;
    lines.push(`**${label} ${arr.length} 班**`, ...arr.slice(0, 15).map(desc));
    if (arr.length > 15) lines.push(`- …及其他 ${arr.length - 15} 班`);
    lines.push("");
  };
  show(added, "新增");
  show(removed, "取消");
  if (retimed) lines.push(`**沿途時刻調整 ${retimed} 班**（始發時刻相同、途中時刻有變）`, "");
}

if (lines.length) {
  console.log("## 🚇 偵測到官方時刻表改點\n");
  console.log(`資料版本：\`${A.version ?? "?"}\` → \`${B.version ?? "?"}\`\n`);
  console.log(lines.join("\n"));
  console.log("---");
  console.log("此 Issue 由每週排程自動比對產生；網站已同步重新部署，請抽查線上轉乘規劃結果是否合理，確認後關閉即可。");
}
