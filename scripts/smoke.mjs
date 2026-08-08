#!/usr/bin/env node
/**
 * 部署前煙霧測試：起本機靜態伺服器供 _site，以 Playwright（手機視窗）驗證
 * 路線查詢、蛇形路線圖、車站看板、航班頁、語言切換皆有實際渲染。
 * 用法：node scripts/smoke.mjs [siteDir]（預設 _site）
 * 本機無下載瀏覽器時可用 SMOKE_CHROMIUM=/path/to/chromium 指定執行檔。
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const root = process.argv[2] ?? "_site";
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
const srv = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  try {
    const buf = await readFile(join(root, normalize(p).replace(/^([/\\]|\.\.)+/, "")));
    res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => srv.listen(8787, r));

const browser = await chromium.launch(process.env.SMOKE_CHROMIUM ? { executablePath: process.env.SMOKE_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

let failed = null;
const fail = (msg) => { failed = msg; throw new Error(msg); };

try {
  await page.goto("http://localhost:8787/", { waitUntil: "domcontentloaded" });

  // 1. 路線查詢渲染出結果卡（凌晨也會給明日首班）
  await page.waitForSelector(".journey-card", { timeout: 15000 }).catch(() => fail("路線查詢沒有結果卡"));
  console.log("✓ 路線查詢");

  // 2. 手機寬度使用蛇形路線圖且無橫向捲動
  const cls = (await page.getAttribute("#line-map", "class")) ?? "";
  if (!/\bsnake\b/.test(cls)) fail("手機寬度未使用蛇形路線圖");
  const over = await page.evaluate(() => {
    const el = document.querySelector(".line-map-scroll");
    return el.scrollWidth - el.clientWidth;
  });
  if (over > 2) fail(`蛇形路線圖仍有 ${over}px 橫向捲動`);
  const circles = await page.$$eval("#line-map circle", (els) => els.length);
  if (circles < 22) fail(`路線圖站點數異常（${circles}）`);
  console.log("✓ 蛇形路線圖（無橫向捲動）");

  // 3. 車站看板（深夜無班次時允許空清單列）
  await page.click("#tab-board");
  await page.waitForSelector(".board-row", { timeout: 8000 }).catch(() => fail("車站看板沒有內容"));
  console.log("✓ 車站看板");

  // 4. 航班頁（無 fids.json 時允許顯示無法載入訊息）
  await page.click("#tab-flight");
  await page.waitForSelector(".flight-row, .board-row.empty", { timeout: 10000 }).catch(() => fail("航班頁沒有內容"));
  console.log("✓ 航班頁");

  // 5. 高鐵頁（深夜無班次時允許空清單）
  await page.click("#tab-hsr");
  await page.waitForSelector("#hsr-list .flight-row, #hsr-list .board-row.empty", { timeout: 8000 }).catch(() => fail("高鐵頁沒有內容"));
  console.log("✓ 高鐵頁");

  // 6. 語言切換
  await page.selectOption("#lang-sel", "en");
  await page
    .waitForFunction(() => document.getElementById("tab-plan").textContent.includes("Journey"), null, { timeout: 5000 })
    .catch(() => fail("語言切換未生效"));
  console.log("✓ 語言切換");

  // 視覺回歸截圖（上傳為 Actions artifact，改版時可前後對照）
  await mkdir("smoke-shots", { recursive: true });
  await page.selectOption("#lang-sel", "zh");
  for (const [name, tab] of [["plan", "#tab-plan"], ["board", "#tab-board"], ["flight", "#tab-flight"], ["hsr", "#tab-hsr"]]) {
    await page.click(tab);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `smoke-shots/${name}.png`, fullPage: true });
  }
  console.log("✓ 截圖已存 smoke-shots/");

  // 外部資源（天氣、備援看板）在 CI 允許失敗；其餘頁面錯誤視為致命
  const fatal = errors.filter((e) => !/favicon|open-meteo|vatsim|tdx\.json|fids\.json|Failed to load resource|net::|fetch/i.test(e));
  if (fatal.length) fail(`頁面錯誤：\n${fatal.join("\n")}`);
} catch (e) {
  console.error(`✗ ${failed ?? e.message}`);
  await browser.close();
  srv.close();
  process.exit(1);
}

await browser.close();
srv.close();
console.log("煙霧測試全數通過 ✓");
