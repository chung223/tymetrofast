#!/usr/bin/env node
/**
 * 解析官網車站資訊頁（data/raw/station-info/{tw,en}/）→ data/facilities.json
 * 結構：設施為 css_tr/css_td 標籤值對（標籤以全形冒號結尾），
 * 出口為 <caption>出口資訊</caption> 的表格（Exit No. / Location）。
 * 驗證：至少 20 站、每站中文至少 3 列設施，否則不寫檔並以非零碼結束。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = join(root, "data/raw/station-info");

const decode = (s) => s
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&rsquo;|&#39;/g, "'").replace(/&mdash;/g, "—");

/** 去標籤：li → 分行、br → 分行，其他標籤移除；含 http 的行（廠商網址）捨棄 */
function cellText(html) {
  const t = decode(
    html
      .replace(/<li[^>]*>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
  return t
    .split("\n")
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter((x) => x && !/https?:\/\//.test(x))
    .join("\n");
}

/** 依序抓出所有 css_td 內容（值不含巢狀 div），配對「標籤：」→ 值 */
function parseInfo(html) {
  const cells = [];
  const re = /<div class="css_td"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) cells.push(m[1]);
  const rows = [];
  for (let i = 0; i < cells.length - 1; i++) {
    const label = cellText(cells[i]).replace(/\n.*/s, "");
    if (!/[：:]\s*$/.test(label) || label.length > 20) continue;
    const value = cellText(cells[i + 1]);
    if (!value) continue;
    rows.push([label.replace(/[：:]\s*$/, ""), value]);
    i++;
  }
  return rows;
}

/** 出口資訊表：<caption>出口資訊</caption> 之後的 tbody 列 */
function parseExits(html) {
  const cap = html.indexOf("<caption>出口資訊</caption>");
  if (cap < 0) return [];
  const end = html.indexOf("</table>", cap);
  const seg = html.slice(cap, end < 0 ? undefined : end);
  const exits = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(seg))) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((x) => cellText(x[1]).replace(/\n/g, " "));
    if (cells.length < 2 || /Exit No|出口編號/i.test(cells[0])) continue;
    exits.push([cells[0], cells.slice(1).filter(Boolean).join("・")]);
  }
  return exits;
}

const STATIONS = "A1 A2 A3 A4 A5 A6 A7 A8 A9 A10 A11 A12 A13 A14a A15 A16 A17 A18 A19 A20 A21 A22".split(" ");
const out = { updated: new Date().toISOString().slice(0, 10), source: "桃園捷運官網車站資訊頁", stations: {} };
let okZh = 0;

for (const id of STATIONS) {
  const entry = {};
  for (const [lang, key] of [["tw", "zh"], ["en", "en"]]) {
    const f = join(rawDir, lang, `${id}.html`);
    if (!existsSync(f)) continue;
    const html = readFileSync(f, "utf8");
    const info = parseInfo(html);
    const exits = parseExits(html);
    if (info.length || exits.length) entry[key] = { info, exits };
  }
  if (entry.zh?.info?.length >= 3) okZh++;
  if (Object.keys(entry).length) out.stations[id] = entry;
  console.log(`${id}: zh ${entry.zh?.info?.length ?? 0} 列設施/${entry.zh?.exits?.length ?? 0} 出口, en ${entry.en?.info?.length ?? 0}/${entry.en?.exits?.length ?? 0}`);
}

if (okZh < 20) {
  console.error(`只有 ${okZh} 站解析出足夠設施列（需 ≥20），不寫檔`);
  process.exit(1);
}
console.log("\n樣本（A1 zh 前 4 列）:", JSON.stringify(out.stations.A1?.zh?.info?.slice(0, 4), null, 1));
writeFileSync(join(root, "data/facilities.json"), JSON.stringify(out));
console.log(`已寫入 data/facilities.json（${okZh} 站完整）`);
