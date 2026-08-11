#!/usr/bin/env node
/**
 * 抓取 TDX 加值資料到 .tdx-extras/（不進版控）：
 *   - 桃捷票價 ODFare/TYMC
 *   - 高鐵車站清單與定期時刻表（供 A18 高鐵接駁）
 * 用法：node scripts/fetch-extras.mjs（需 TDX_CLIENT_ID/TDX_CLIENT_SECRET）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, ".tdx-extras");
mkdirSync(outDir, { recursive: true });

async function getToken() {
  const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
  if (!id || !secret) { console.log("（未設定 TDX 金鑰，跳過加值資料）"); process.exit(0); }
  const r = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!r.ok) {
    // 金鑰停權／額度用罄時 TDX 回 400 invalid_client（非 401/403）。重跑也不會好，
    // 溫和跳出、沿用既有加值資料，不讓排程每週寄一封失敗信。
    const detail = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    console.log(`::warning::TDX token 回應 ${r.status}${detail ? `：${detail}` : ""}——金鑰可能已達額度上限或被停用，本輪跳過加值資料`);
    process.exit(0);
  }
  return (await r.json()).access_token;
}

const token = await getToken();
const TARGETS = [
  ["ODFare", "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/ODFare/TYMC?%24top=100000&%24format=JSON"],
  ["THSR_Station", "https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/Station?%24top=100&%24format=JSON"],
  ["THSR_GeneralTimetable", "https://tdx.transportdata.tw/api/basic/v2/Rail/THSR/GeneralTimetable?%24top=2000&%24format=JSON"],
];

// TDX 免費額度有短時間連續呼叫限流：429 時等 65 秒重試
async function fetchRetry(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
    if (r.status === 429 && i < 2) {
      console.log("  （限流，65 秒後重試）");
      await new Promise((res) => setTimeout(res, 65000));
      continue;
    }
    return r;
  }
}

let ok = 0;
for (const [name, url] of TARGETS) {
  if (ok) await new Promise((r) => setTimeout(r, 1500));
  try {
    const r = await fetchRetry(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
    const data = await r.json();
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(data));
    console.log(`✓ ${name}: ${Array.isArray(data) ? data.length : "?"} 筆`);
    ok++;
  } catch (e) {
    console.error(`✗ ${name}: ${e.message}`);
  }
}
process.exit(ok ? 0 : 1);
