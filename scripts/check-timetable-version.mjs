#!/usr/bin/env node
/**
 * 探 TDX 桃捷時刻表的版本號，決定這輪要不要真的重抓。
 * 只打一次 API 且加上 $top=1&$select，回應只有幾十個位元組——這樣排程可以
 * 保持規律，而爬官網 22×2 頁＋抓 7 份 TDX 資源只在官方真的改點時才發生。
 *
 * 輸出到 $GITHUB_OUTPUT：changed=true|false、version=<VersionID>
 * 取不到版本（額度用罄／TDX 異常）時輸出 changed=false，本輪安靜跳過。
 * 用法：node scripts/check-timetable-version.mjs
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const emit = (k, v) => {
  console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
};
const skip = (why) => {
  console.log(`::warning::${why}——本輪不重抓班表`);
  emit("changed", "false");
  process.exit(0);
};

const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
if (!id || !secret) skip("未設定 TDX 金鑰");

const tokRes = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
});
if (!tokRes.ok) skip(`TDX token 回應 ${tokRes.status}`);
const token = (await tokRes.json()).access_token;

const url = "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro/StationTimeTable/TYMC"
  + "?%24top=1&%24select=VersionID%2CSrcUpdateTime&%24format=JSON";
const res = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${token}` } });
if (!res.ok) skip(`TDX 查版本回應 ${res.status}`);
const rows = await res.json();
const version = String(rows?.[0]?.VersionID ?? "");
const srcUpdate = rows?.[0]?.SrcUpdateTime ?? "";
if (!version) skip("TDX 沒回 VersionID");

const ttPath = join(root, "data/timetable.json");
const current = existsSync(ttPath) ? JSON.parse(readFileSync(ttPath, "utf8")).srcVersion ?? "" : "";
const changed = String(current) !== version;
console.log(`官方版本 ${version}（${srcUpdate}）／目前建置自 ${current || "（未記錄）"}`);
emit("version", version);
emit("changed", String(changed));
if (!changed) console.log("班表未改版，跳過重抓");
