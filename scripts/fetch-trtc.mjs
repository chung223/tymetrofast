#!/usr/bin/env node
/**
 * 抓取台北都會區捷運靜態資料 → data/trtc.json、data/trtc-fares.json
 * 涵蓋兩個業者：
 *   TRTC 台北捷運公司（文湖 BR／淡水信義 R／松山新店 G／中和新蘆 O／板南 BL）
 *   NTMC 新北捷運公司（環狀線 Y；終點新北產業園區與機捷 A3 共站）
 * 兩者站號不重疊，可直接併成同一張網；同名站（大坪林、景安…）由前端的
 * 共構站合併看板處理。
 *
 * 皆屬班距制、無逐班時刻表，全部資料靜態（週更即可）：
 * 車站／路線站序／站間行駛時間／轉乘步行時間／班距／首末班車／全 OD 票價。
 * 各區塊獨立容錯；TRTC 是主體，NTMC 失敗只警告不影響寫檔。
 * 用法：node scripts/fetch-trtc.mjs（需 TDX_CLIENT_ID/TDX_CLIENT_SECRET）
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = (f, obj) => writeFileSync(join(root, "data", f), JSON.stringify(obj));

const id = process.env.TDX_CLIENT_ID, secret = process.env.TDX_CLIENT_SECRET;
if (!id || !secret) { console.error("缺 TDX 金鑰"); process.exit(1); }
// 額度用罄／金鑰停用不算「壞掉」：保留線上既有資料、溫和跳出，避免每半小時寄一封失敗信。
const quotaOut = (status, where, detail = "") => {
  console.log(`::warning::TDX ${where} 回應 ${status}${detail ? `：${detail}` : ""}——金鑰可能已達額度上限或被停用，本輪跳過，沿用既有資料`);
  process.exit(0);
};

const tokRes = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
});
// 金鑰有設定卻換不到 token，重跑也不會好，讓工作流失敗只是多寄一封信，故一律溫和跳出。
// （實測金鑰被停權時 TDX 回 400 invalid_client，並非 401/403，因此不挑狀態碼。）
if (!tokRes.ok) {
  quotaOut(tokRes.status, "token", (await tokRes.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160));
}
const token = (await tokRes.json()).access_token;

const BASE = "https://tdx.transportdata.tw/api/basic/v2/Rail/Metro";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nap = () => sleep(13500); // TDX 免費層約每分鐘 5 次
async function get(path) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/${path}${path.includes("?") ? "&" : "?"}%24format=JSON`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (r.status === 429 && i < 2) { console.log("  （限流，65 秒後重試）"); await sleep(65000); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path.split("?")[0]}`);
    return r.json();
  }
}
const sample = (tag, arr) => arr?.[0] && console.log(`${tag} 首筆樣本:`, JSON.stringify(arr[0]).slice(0, 450));

const stamp = new Date(new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace(" ", "T"))
  .toISOString().slice(0, 16).replace("T", " ");
const data = { updated: stamp, stations: {}, lines: {}, transfers: [], firstLast: {}, freq: [] };

// 業者：main=true 者是主體，區塊成功數會納入寫檔門檻；min 是該業者的合理下限
const OPERATORS = [
  { op: "TRTC", label: "北捷", main: true, min: { stations: 100, lines: 4, segs: 100, transfers: 10, freq: 20, firstLast: 80 } },
  { op: "NTMC", label: "環狀線", main: false, min: { stations: 10, lines: 1, segs: 10, transfers: 1, freq: 1, firstLast: 8 } },
];

let ok = 0;               // 主體業者成功的區塊數
const okOf = (m) => (m ? ok++ : 0);
let first = true;
const step = async () => { if (!first) await nap(); first = false; };

for (const { op, label, main, min } of OPERATORS) {
  console.log(`\n───── ${op}（${label}） ─────`);

  /* ── 車站（座標＋名稱） ── */
  try {
    await step();
    const raw = await get(`Station/${op}`);
    if (main) sample("車站", raw);
    let n = 0;
    for (const s of raw) {
      data.stations[s.StationID] = {
        zh: s.StationName?.Zh_tw ?? "",
        en: s.StationName?.En ?? "",
        lat: s.StationPosition?.PositionLat ?? null,
        lon: s.StationPosition?.PositionLon ?? null,
      };
      n++;
    }
    if (n < min.stations) throw new Error(`僅 ${n} 站`);
    console.log(`✓ 車站 ${n} 站`);
    okOf(main);
  } catch (e) { console.log(`::warning::${op} 車站失敗：${e.message}`); }

  /* ── 路線站序 ── */
  try {
    await step();
    const raw = await get(`StationOfLine/${op}`);
    if (main) sample("站序", raw);
    const added = [];
    for (const l of raw) {
      data.lines[l.LineID] = {
        stations: (l.Stations ?? []).sort((a, b) => (a.Sequence ?? 0) - (b.Sequence ?? 0)).map((s) => s.StationID),
      };
      added.push(l.LineID);
    }
    if (added.length < min.lines) throw new Error(`僅 ${added.length} 線`);
    console.log(`✓ 路線 ${added.length} 線：${added.join(",")}`);
    okOf(main);
  } catch (e) { console.log(`::warning::${op} 路線失敗：${e.message}`); }

  /* ── 站間行駛時間（含停站秒數） ── */
  try {
    await step();
    const raw = await get(`S2STravelTime/${op}`);
    if (main) sample("站間", raw);
    // 回應按「線×路線」分列（BL-1、BL-2…），須合併去重而非覆蓋
    let added = 0;
    for (const l of raw) {
      const line = data.lines[l.LineID] ?? (data.lines[l.LineID] = { stations: [] });
      line.s2s ??= [];
      const seen = new Set(line.s2s.map(([a, b]) => `${a}|${b}`));
      for (const x of l.TravelTimes ?? []) {
        const key = `${x.FromStationID}|${x.ToStationID}`;
        if (seen.has(key) || seen.has(`${x.ToStationID}|${x.FromStationID}`)) continue;
        seen.add(key);
        line.s2s.push([
          x.FromStationID, x.ToStationID,
          Math.round(((x.RunTime ?? 0) + (x.StopTime ?? 0)) / 6) / 10, // 分鐘（一位小數）
        ]);
        added++;
      }
    }
    if (added < min.segs) throw new Error(`僅 ${added} 段`);
    console.log(`✓ 站間 ${added} 段`);
    okOf(main);
  } catch (e) { console.log(`::warning::${op} 站間時間失敗：${e.message}`); }

  /* ── 轉乘步行時間 ── */
  try {
    await step();
    const raw = await get(`LineTransfer/${op}`);
    if (main) sample("轉乘", raw);
    let added = 0;
    for (const x of raw) {
      // 實測 TransferDescription 北捷 34 組全為空字串（欄位存在但未填），仍容錯保留
      const rv = x.TransferDescription;
      const desc = String((typeof rv === "string" ? rv : rv?.Zh_tw ?? rv?.zh_tw
        ?? (Array.isArray(rv) ? rv.filter(Boolean).join("；") : "")) ?? "").trim();
      data.transfers.push([
        x.FromStationID, x.ToStationID,
        x.FromLineID ?? "", x.ToLineID ?? "",
        Math.round((x.TransferTime ?? 3) * 10) / 10, // 分鐘
        desc, // 官方動線描述（若未來補填即自動顯示）
        x.IsOnSiteTransfer == null ? 1 : x.IsOnSiteTransfer ? 1 : 0, // 站內 1／站外 0
      ]);
      added++;
    }
    if (added < min.transfers) throw new Error(`僅 ${added} 組`);
    console.log(`✓ 轉乘 ${added} 組`);
    okOf(main);
  } catch (e) { console.log(`::warning::${op} 轉乘失敗：${e.message}`); }

  /* ── 班距（分平日/假日、時段） ── */
  try {
    await step();
    const raw = await get(`Frequency/${op}`);
    if (main) sample("班距", raw);
    let added = 0;
    for (const f of raw) {
      const svc = f.ServiceDay ?? {};
      const days = [svc.Monday, svc.Tuesday, svc.Wednesday, svc.Thursday, svc.Friday, svc.Saturday, svc.Sunday]
        .map((v) => (v ? 1 : 0));
      for (const h of f.Headways ?? []) {
        data.freq.push([
          f.LineID ?? "", days.join(""),
          h.StartTime ?? "", h.EndTime ?? "",
          Math.round(((h.MinHeadwayMins ?? h.MaxHeadwayMins ?? 6) + (h.MaxHeadwayMins ?? h.MinHeadwayMins ?? 6)) / 2 * 10) / 10,
        ]);
        added++;
      }
    }
    if (added < min.freq) throw new Error(`僅 ${added} 筆`);
    console.log(`✓ 班距 ${added} 筆`);
    okOf(main);
  } catch (e) { console.log(`::warning::${op} 班距失敗：${e.message}`); }

  /* ── 首末班車 ── */
  try {
    await step();
    const raw = await get(`FirstLastTimetable/${op}`);
    if (main) sample("首末班", raw);
    const seen = new Set();
    for (const x of raw) {
      const sid = x.StationID;
      seen.add(sid);
      (data.firstLast[sid] ??= []).push([
        x.LineID ?? "", x.TripHeadSign ?? x.DestinationStaionID ?? x.DestinationStationID ?? "",
        x.FirstTrainTime ?? "", x.LastTrainTime ?? "",
        [x.ServiceDay?.Monday, x.ServiceDay?.Tuesday, x.ServiceDay?.Wednesday, x.ServiceDay?.Thursday,
         x.ServiceDay?.Friday, x.ServiceDay?.Saturday, x.ServiceDay?.Sunday].map((v) => (v ? 1 : 0)).join(""),
      ]);
    }
    if (seen.size < min.firstLast) throw new Error(`僅 ${seen.size} 站`);
    console.log(`✓ 首末班 ${seen.size} 站`);
    okOf(main);
  } catch (e) { console.log(`::warning::${op} 首末班失敗：${e.message}`); }
}

/* ── 跨業者同名站補轉乘 ──
 * TDX 的 LineTransfer 各業者自成一份，環狀線 ↔ 北捷（大坪林、景安、板橋…）
 * 未必兩邊都列。同名不同站號等於實體同站，官方沒給就補一組保守的步行時間，
 * 否則規劃引擎會以為兩條線碰不到。 */
{
  const known = new Set(data.transfers.map(([a, b]) => `${a}|${b}`));
  const byName = {};
  for (const [sid, s] of Object.entries(data.stations)) (byName[s.zh] ??= []).push(sid);
  let added = 0;
  for (const [name, ids] of Object.entries(byName)) {
    if (ids.length < 2) continue;
    for (const a of ids) for (const b of ids) {
      if (a === b || known.has(`${a}|${b}`)) continue;
      known.add(`${a}|${b}`);
      // 5 分鐘：比北捷官方站內轉乘（多為 2–4 分）保守，寧可高估不要誤導
      data.transfers.push([a, b, "", "", 5, "", 1]);
      added++;
    }
  }
  if (added) console.log(`\n✓ 補跨業者同名站轉乘 ${added} 組（官方未列的部分）`);
}

const lineIds = Object.keys(data.lines);
console.log(`\n合計：${Object.keys(data.stations).length} 站／${lineIds.length} 線（${lineIds.join(",")}）／轉乘 ${data.transfers.length} 組`);
if (ok >= 5) {
  out("trtc.json", data);
  console.log(`已寫入 data/trtc.json（主體 ${ok}/6 區塊成功）`);
} else {
  console.log(`::warning::主體成功區塊過少（${ok}/6），不寫 trtc.json`);
}

/* ── 全 OD 票價（獨立檔，較大） ── */
const pairs = {};
for (const { op, main } of OPERATORS) {
  try {
    await step();
    const raw = await get(`ODFare/${op}`);
    if (main) sample("票價", raw);
    let added = 0;
    for (const r of raw) {
      const o = r.OriginStationID, d = r.DestinationStationID;
      const fare = (r.Fares ?? []).find((f) => f.TicketType === 1 && f.FareClass === 1)
        ?? (r.Fares ?? []).find((f) => /全票|Adult/i.test(`${f.FareClassName ?? ""}${f.TicketTypeName ?? ""}`))
        ?? (r.Fares ?? [])[0];
      if (o && d && fare?.Price != null) { pairs[`${o}|${d}`] = fare.Price; added++; }
    }
    console.log(`✓ ${op} 票價 ${added} 組`);
  } catch (e) { console.log(`::warning::${op} 票價失敗：${e.message}`); }
}
if (Object.keys(pairs).length >= 5000) {
  out("trtc-fares.json", { updated: stamp, pairs });
  console.log(`已寫入 data/trtc-fares.json（${Object.keys(pairs).length} 組）`);
} else {
  console.log(`::warning::票價僅 ${Object.keys(pairs).length} 組，不寫 trtc-fares.json`);
}
