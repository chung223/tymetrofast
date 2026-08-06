#!/usr/bin/env node
/**
 * 產生每個起訖組合的迷你分享頁 → <outDir>/s/A1-A13.html
 * 目的：社群/通訊軟體爬蟲不執行 JS 也看不到 #hash，預先鋪好 OG 預覽資訊；
 * 真人打開後由 JS 帶著 query 的時間參數跳轉回主頁 hash 路由。
 * 用法：node scripts/build-share-pages.mjs [outDir]（預設 _site）
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, process.argv[2] ?? "_site", "s");
mkdirSync(outDir, { recursive: true });

const network = JSON.parse(readFileSync(join(root, "data/network.json"), "utf8"));
let fares = null;
try { fares = JSON.parse(readFileSync(join(root, "data/fares.json"), "utf8")).pairs; } catch { /* 無票價仍可產生 */ }

const SITE = "https://chung223.github.io/tymetrofast/";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
let n = 0;

for (const a of network.stations) {
  for (const b of network.stations) {
    if (a.id === b.id) continue;
    const fare = fares?.[`${a.id}|${b.id}`] ?? fares?.[`${b.id}|${a.id}`];
    const title = `${a.id} ${a.name} → ${b.id} ${b.name}｜機捷快轉`;
    const desc = `桃園機場捷運最快搭法：直達車＋轉乘逐班計算${fare ? `，單程票價 NT$${fare}` : ""}。點開看目前最快班次與月台指引。`;
    const target = `${SITE}#from=${a.id}&to=${b.id}`;
    writeFileSync(join(outDir, `${a.id}-${b.id}.html`), `<!DOCTYPE html>
<html lang="zh-Hant-TW"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="機捷快轉">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${SITE}icons/og.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#120f0a">
<link rel="icon" href="../icons/icon.svg" type="image/svg+xml">
<style>body{background:#16120c;color:#a29377;font-family:sans-serif;display:grid;place-items:center;min-height:100dvh;margin:0}a{color:#d4af6e}</style>
</head><body>
<p><a href="${target}" id="go">${esc(title)} — 開啟機捷快轉 ▶</a></p>
<script>
const q = new URLSearchParams(location.search);
const parts = ["from=${a.id}", "to=${b.id}"];
if (["depart","arrive"].includes(q.get("m"))) parts.push("m=" + q.get("m"));
if (/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/.test(q.get("t") || "")) parts.push("t=" + q.get("t"));
location.replace("../#" + parts.join("&"));
</script>
</body></html>`);
    n++;
  }
}
console.log(`已產生 ${n} 個分享頁 → ${outDir}`);
