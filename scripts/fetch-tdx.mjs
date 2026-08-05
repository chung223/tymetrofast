#!/usr/bin/env node
/**
 * 從 TDX 運輸資料流通服務抓取桃園捷運（TYMC）官方班表原始資料，存到 data/raw/tdx/。
 * 用法：node scripts/fetch-tdx.mjs
 *
 * 環境變數（建議設定，否則用匿名額度、很容易被限流）：
 *   TDX_CLIENT_ID / TDX_CLIENT_SECRET —— 到 https://tdx.transportdata.tw 免費註冊取得
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "data/raw/tdx");
mkdirSync(outDir, { recursive: true });

const BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro";
const RESOURCES = [
  "Station",
  "StationOfLine",
  "Line",
  "StationTimeTable",
  "S2STravelTime",
  "Frequency",
  "FirstLastTimetable",
];

async function getToken() {
  const id = process.env.TDX_CLIENT_ID;
  const secret = process.env.TDX_CLIENT_SECRET;
  if (!id || !secret) {
    console.log("（未設定 TDX_CLIENT_ID/SECRET，改用匿名存取——額度有限，建議到 repo Settings → Secrets 補上）");
    return null;
  }
  const r = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!r.ok) throw new Error(`TDX 取得 token 失敗: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

const token = await getToken();
let okCount = 0;
for (const res of RESOURCES) {
  const url = `${BASE}/${res}/TYMC?%24top=100000&%24format=JSON`;
  try {
    const r = await fetch(url, {
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    writeFileSync(join(outDir, `${res}.json`), JSON.stringify(data, null, 1));
    const n = Array.isArray(data) ? data.length : Object.keys(data).length;
    console.log(`✓ ${res}: ${n} 筆`);
    okCount++;
  } catch (e) {
    console.error(`✗ ${res}: ${e.message}`);
  }
}

writeFileSync(
  join(outDir, "meta.json"),
  JSON.stringify({ fetchedAt: new Date().toISOString(), authenticated: !!token, okCount, total: RESOURCES.length }, null, 1)
);
if (okCount === 0) {
  console.error("全部資源抓取失敗");
  process.exit(1);
}
console.log(`完成：${okCount}/${RESOURCES.length}`);
