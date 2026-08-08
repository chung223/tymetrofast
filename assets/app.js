/* 快轉 · 前端主程式 */
import { buildIndex, planDirect, planOptions, planJourney, planArriveBy, fmtTime } from "./planner.js";
import { buildTrtcGraph, planTrtc, headwayOf } from "./trtc-engine.mjs";
import { LANGS, LANG_LABEL, makeT } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const loadJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(u)));
const tryJson = (u) => loadJson(u).catch(() => null);

const [network, timetable, holidaysFile, extraNames, geo, faresFile, hsrFile, passesFile, itciFile, facFile, schedFile, termFile, thsrStFile, thsrTTFile, thsrFareFile, thsrLiveFile, alertsFile, trtcFile, trtcFareFile, linksFile, workerFile] = await Promise.all([
  loadJson("data/network.json"),
  loadJson("data/timetable.json"),
  loadJson("data/holidays.json"),
  tryJson("data/station-names.json"),
  tryJson("data/geo.json"),
  tryJson("data/fares.json"),
  tryJson("data/hsr-a18.json"),
  tryJson("data/passes.json"),
  tryJson("data/itci.json"),
  tryJson("data/facilities.json"),
  tryJson("data/fids-future.json"),
  tryJson("data/terminals.json"),
  tryJson("data/thsr-stations.json"),
  tryJson("data/thsr-timetable.json"),
  tryJson("data/thsr-fares.json"),
  tryJson("data/thsr-live.json"),
  tryJson("data/alerts.json"),
  tryJson("data/trtc.json"),
  tryJson("data/trtc-fares.json"),
  tryJson("data/links.json"),
  tryJson("data/worker.json"),
]);
const holidays = new Set(holidaysFile.holidays);
const stations = network.stations;
const stationById = new Map(stations.map((s) => [s.id, s]));
const fares = faresFile?.pairs ?? null;
const hsr = hsrFile?.trains?.length ? hsrFile.trains : null;
const passes = passesFile?.passes?.length ? passesFile.passes : null;
const itci = itciFile?.airlines?.length ? itciFile : null;
const facilities = facFile?.stations ?? null;
const fidsFuture = schedFile?.airports?.TPE ?? null;
const terminals = termFile?.terminals ?? null;
const thsrStations = thsrStFile?.stations?.length >= 10 ? thsrStFile.stations : null;
const thsrTT = thsrTTFile?.days ?? null;
const thsrFares = thsrFareFile?.pairs ?? null;
const thsrSeat = thsrLiveFile?.seat ?? null;
const sysAlerts = alertsFile?.alerts ?? [];
const TY = "1020"; // 高鐵桃園站
const SITE_URL = "https://chung223.github.io/tymetrofast/";

/* ---------- 🚇 台北捷運（班距制） ---------- */
// 抓取端已驗證完整性（<100 站不寫檔），此處僅防空殼
const trtc = trtcFile?.stations && Object.keys(trtcFile.stations).length >= 10 ? trtcFile : null;
const trtcFares = trtcFareFile?.pairs ?? null;
const trtcGraph = trtc ? buildTrtcGraph(trtc) : null;
const TRTC_COLORS = { BR: "#c48c31", R: "#e3002c", G: "#008659", O: "#f8b61c", BL: "#0070bd" };
const trtcLineOf = (id) => id.match(/^[A-Z]+/)?.[0] ?? "";
const isTrtc = (id) => !!trtc?.stations?.[id];
const trtcStnName = (id) => {
  const s = trtc?.stations?.[id];
  return s ? (lang === "zh" ? s.zh : s.en || s.zh) : id;
};
// 即時中繼站（Cloudflare Worker；無設定時北捷看板退回班距推估）
const liveApi = /^https:\/\//.test(workerFile?.url ?? "") ? workerFile.url.replace(/\/$/, "") : null;
// 機捷×北捷連結點：站名 → 北捷站碼（多線站全對應）
const mrtLinks = (linksFile?.links ?? []).map((L) => ({
  ...L,
  trtcIds: trtc
    ? Object.entries(trtc.stations).filter(([, s]) => L.trtcNames.includes(s.zh)).map(([sid]) => sid)
    : [],
})).filter((L) => L.trtcIds.length);
const hm2min = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
const indexCache = new Map();
const getIndex = (dayType) => {
  if (!indexCache.has(dayType)) indexCache.set(dayType, buildIndex(network, timetable, dayType));
  return indexCache.get(dayType);
};

/* ---------- 語言 ---------- */
const savedLang = localStorage.getItem("tymf-lang");
const navLang = (navigator.language || "zh").toLowerCase();
let lang = savedLang && LANGS.includes(savedLang) ? savedLang
  : navLang.startsWith("zh") ? "zh" : navLang.startsWith("ja") ? "ja" : navLang.startsWith("ko") ? "ko" : LANGS.includes(navLang.slice(0, 2)) ? navLang.slice(0, 2) : "en";
let t = makeT(lang);
const stnName = (id) => {
  if (!stationById.has(id)) return trtcStnName(id);
  return lang === "zh" ? stationById.get(id).name : extraNames?.[id]?.[lang] || stationById.get(id).nameEn;
};
const stnLabel = (id) => `${id} ${stnName(id)}`;

/* ---------- 台灣時間 ---------- */
function taipeiNow() {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" });
  const min = Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
  return { date: s.slice(0, 10), min, minF: min + Number(s.slice(17, 19)) / 60 };
}
function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const dowOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=Sun
function dayTypeOf(dateStr) {
  if (holidays.has(dateStr)) return "holiday";
  const dow = dowOf(dateStr);
  return dow === 0 || dow === 6 ? "holiday" : "weekday";
}

/* ---------- 狀態 ---------- */
const state = {
  view: "plan", from: "A1", to: "A16", boardStation: "A1", mode: "now", custom: null,
  flightCtx: null, flightDir: "dep", hsrCtx: null, hsrDir: 1,
  thsrFrom: localStorage.getItem("trav-hsr-from") ?? "1000", thsrTo: "1070", thsrDay: 0, thsrSeatOnly: false,
};
if (state.thsrFrom === state.thsrTo) state.thsrTo = state.thsrFrom === "1000" ? "1070" : "1000";
let hashHadFrom = false, pendingFlightSearch = null, pendingView = null;
(function initFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const validStn = (x) => stationById.has(x) || isTrtc(x);
  if (validStn(p.get("from"))) { state.from = p.get("from"); hashHadFrom = true; }
  if (validStn(p.get("to"))) state.to = p.get("to");
  const m = p.get("m");
  if (m === "arrive" || m === "depart") state.mode = m;
  if (p.get("t") && p.get("t") !== "now") state.custom = p.get("t");
  if (state.mode !== "now" && !state.custom) state.mode = "now";
  if (p.get("flight")) pendingFlightSearch = p.get("flight").toUpperCase();
  if (["board", "flight", "hsr"].includes(p.get("v"))) pendingView = p.get("v");
})();
{
  const savedBoard = localStorage.getItem("tymf-board-stn");
  if (savedBoard && (stationById.has(savedBoard) || isTrtc(savedBoard))) state.boardStation = savedBoard;
}
function syncHash() {
  const parts = [`from=${state.from}`, `to=${state.to}`, `m=${state.mode}`];
  if (state.mode !== "now" && state.custom) parts.push(`t=${state.custom}`);
  history.replaceState(null, "", `#${parts.join("&")}`);
}

/* ---------- 最愛路線 ---------- */
const favs = JSON.parse(localStorage.getItem("tymf-favs") ?? "[]");
const favKey = () => `${state.from}|${state.to}`;
function renderFavs() {
  const box = $("fav-row");
  const isFav = favs.some((f) => f === favKey());
  let html = `<button class="fav-star ${isFav ? "on" : ""}" id="fav-toggle">${isFav ? t("favSaved") : t("favSave")}</button>`;
  for (const f of favs) {
    const [a, b] = f.split("|");
    html += `<button class="fav-chip ${f === favKey() ? "cur" : ""}" data-fav="${f}"><span class="fc">${a}</span>→<span class="fc">${b}</span></button>`;
  }
  box.innerHTML = html;
  $("fav-toggle").onclick = () => {
    const k = favKey();
    const i = favs.indexOf(k);
    if (i >= 0) favs.splice(i, 1);
    else { favs.unshift(k); favs.splice(6); }
    localStorage.setItem("tymf-favs", JSON.stringify(favs));
    renderFavs();
  };
  box.querySelectorAll("[data-fav]").forEach((btn) => (btn.onclick = () => {
    [state.from, state.to] = btn.dataset.fav.split("|");
    refreshOD(); syncHash(); runQuery(); renderFavs();
  }));
}

/* ---------- 查詢 ---------- */
function queryContext() {
  if (state.mode === "now" || !state.custom) return taipeiNow();
  return { date: state.custom.slice(0, 10), min: Number(state.custom.slice(11, 13)) * 60 + Number(state.custom.slice(14, 16)) };
}
function candidatesFor(ctx, key) {
  const list = [{ dayType: dayTypeOf(ctx.date), [key]: ctx.min, dayOffset: 0 }];
  if (ctx.min < 180) list.push({ dayType: dayTypeOf(shiftDate(ctx.date, -1)), [key]: ctx.min + 1440, dayOffset: -1 });
  return list;
}
const abs = (j) => j.arr + j.dayOffset * 1440;
const absDep = (j) => j.dep + j.dayOffset * 1440;

function collect(cands, from, to, count) {
  const opts = [];
  let direct = null;
  for (const c of cands) {
    const idx = getIndex(c.dayType);
    for (const j of planOptions(idx, { from, to, departAfter: c.departAfter, count })) {
      opts.push({ ...j, dayOffset: c.dayOffset });
    }
    const d = planDirect(idx, { from, to, departAfter: c.departAfter });
    if (d) {
      d.dayOffset = c.dayOffset;
      if (!direct || abs(d) < abs(direct)) direct = d;
    }
  }
  opts.sort((a, b) => abs(a) - abs(b) || absDep(b) - absDep(a));
  const clean = [];
  for (const o of opts) {
    if (!clean.some((k) => absDep(k) >= absDep(o) && abs(k) <= abs(o))) clean.push(o);
  }
  return { options: clean.slice(0, 4), direct };
}

function runQuery() {
  if (state.view !== "plan") return;
  const { from, to } = state;
  const ctx = queryContext();
  const dayType = dayTypeOf(ctx.date);
  $("daytype-chip").textContent = `${ctx.date.slice(5).replace("-", "/")} ${t(dayType === "weekday" ? "weekdaySched" : "holidaySched")}`;

  if (from === to) { renderResults({ error: t("sameStation") }); return; }
  // 北捷起訖 → 班距制／跨系統聯程引擎
  if (isTrtc(from) || isTrtc(to)) { renderHybrid(from, to, ctx); return; }

  if (state.mode === "arrive") {
    const results = [];
    for (const c of candidatesFor(ctx, "arriveBy")) {
      const idx = getIndex(c.dayType);
      let target = c.arriveBy;
      for (let i = 0; i < 3; i++) {
        const j = planArriveBy(idx, { from, to, arriveBy: target });
        if (!j) break;
        results.push({ ...j, dayOffset: c.dayOffset });
        target = j.dep - 0.5;
      }
    }
    results.sort((a, b) => absDep(b) - absDep(a));
    const dedup = [];
    for (const r of results) if (!dedup.some((k) => absDep(k) === absDep(r))) dedup.push(r);
    if (dedup.length) {
      renderResults({ options: dedup.slice(0, 3), arriveMode: true, ctx });
    } else {
      const { options, direct } = collect(candidatesFor({ ...ctx }, "departAfter").map((c) => ({ ...c, departAfter: c.arriveBy ?? c.departAfter ?? ctx.min })), from, to, 3);
      renderResults({ options, direct, cantMake: true, ctx });
    }
    return;
  }

  let { options, direct } = collect(candidatesFor(ctx, "departAfter"), from, to, 4);
  let nextDay = null;
  if (!options.length) {
    const d1 = shiftDate(ctx.date, 1);
    const r = collect([{ dayType: dayTypeOf(d1), departAfter: 0, dayOffset: 1 }], from, to, 2);
    options = r.options; direct = r.direct; nextDay = d1;
  }
  renderResults({ options, direct, nextDay, ctx });
}

/* ---------- 🚇 北捷／跨系統聯程呈現 ---------- */
const lineChip = (lid) => `<span class="line-chip" style="--lc:${TRTC_COLORS[trtcLineOf(lid)] ?? "#888"}">${lid}</span>`;

function trtcLegsHtml(r, startMin) {
  let cur = startMin;
  return r.legs.map((l) => {
    const parts = [t("waitEst", Math.round(l.waitMin))];
    if (l.walkMin) parts.unshift(t("walkN", Math.round(l.walkMin)));
    parts.push(t("rideN", Math.round(l.rideMin)));
    if (l.stops > 1) parts.push(t("stopsVia", l.stops - 1));
    cur += l.waitMin + l.walkMin + l.rideMin;
    return `
    <div class="leg trtc-leg">
      <div class="leg-rail" style="--lc:${TRTC_COLORS[trtcLineOf(l.line)] ?? "#888"}"></div>
      <div class="leg-body">
        <div class="leg-line1">
          ${lineChip(trtcLineOf(l.line))}
          <span class="leg-stations">${stnLabel(l.from)} → ${stnLabel(l.to)}</span>
        </div>
        <div class="leg-detail">${parts.join(" · ")}</div>
      </div>
    </div>`;
  }).join("");
}

/** 北捷首末班警告：首段上車站該線的最晚末班早於上車時刻時提示 */
function trtcLastWarn(r, boardMin, holiday) {
  const first = r.legs[0];
  const rows = (trtc.firstLast?.[first.from] ?? []).filter(([line, , , , days]) =>
    trtcLineOf(line) === trtcLineOf(first.line) && days[holiday ? 6 : 2] === "1");
  if (!rows.length) return "";
  let latest = -1;
  for (const [, , , last] of rows) {
    if (!/^\d{2}:\d{2}/.test(last)) continue;
    let m = hm2min(last);
    if (m < 240) m += 1440; // 凌晨末班視為隔日
    latest = Math.max(latest, m);
  }
  return latest >= 0 && boardMin > latest ? `<div class="panel empty-card">⚠ ${t("trtcLastWarn", trtcLineOf(first.line))}</div>` : "";
}

function renderHybrid(from, to, ctx) {
  const box = $("results");
  const holiday = dayTypeOf(ctx.date) === "holiday";
  const fromT = isTrtc(from), toT = isTrtc(to);
  const fc = state.flightCtx;
  const fcBanner = fc && (to === "A12" || to === "A13")
    ? `<aside class="panel flight-banner"><span class="fl-no">✈ ${fc.f}</span><span class="b-time">${fc.st}</span><span class="fl-dest">→ ${fc.o}</span><span class="fl-tag term">${t("terminalL")} ${fc.term} · ${t("alightAt", stnLabel(to))}</span></aside>`
    : "";

  if (!trtcGraph) { box.innerHTML = `<div class="panel empty-card">${t("noneFound")}</div>`; renderLineMap(null); return; }

  /* 純北捷 */
  if (fromT && toT) {
    const r = planTrtc(trtc, trtcGraph, { from, to, min: ctx.min, holiday });
    if (!r) { box.innerHTML = `<div class="panel empty-card">${t("noneFound")}</div>`; renderLineMap(null); return; }
    const fare = trtcFares?.[`${from}|${to}`] ?? trtcFares?.[`${to}|${from}`];
    box.innerHTML = trtcLastWarn(r, ctx.min, holiday) + `
    <article class="panel journey-card best">
      <div class="jc-head">
        <span class="jc-badge">${t("fastest")}</span>
        <span class="jc-times">~${r.totalMin} ${t("min")}</span>
        <span class="jc-meta">${t("arriveEst", fmtTime(ctx.min + r.totalMin))}<br>
          ${r.transfers ? t("transfersN", r.transfers) : t("noTransfer")}${fare ? ` · <span class="fare-chip">${t("fare", fare)}</span>` : ""}</span>
      </div>
      <div class="legs">${trtcLegsHtml(r, ctx.min)}</div>
      <p class="map-hint">${t("estNote")}</p>
    </article>`;
    renderLineMap(null);
    return;
  }

  /* 混合：經連結點（台北車站 A1／三重 A2） */
  const cands = [];
  let mrtDead = false;
  for (const L of mrtLinks) {
    for (const tid of L.trtcIds) {
      if (fromT) {
        const t1 = planTrtc(trtc, trtcGraph, { from, to: tid, min: ctx.min, holiday });
        if (!t1) continue;
        const arriveLink = ctx.min + t1.totalMin + L.walkMin;
        let j = null;
        try { j = planJourney(getIndex(dayTypeOf(ctx.date)), { from: L.a, to, departAfter: arriveLink }); } catch { /* 無班表 */ }
        if (!j) { mrtDead = true; continue; }
        cands.push({ L, tid, t1, j, arr: j.arr, dep: ctx.min });
      } else {
        let j = null;
        try { j = planJourney(getIndex(dayTypeOf(ctx.date)), { from, to: L.a, departAfter: ctx.min }); } catch { /* 無班表 */ }
        if (!j) { mrtDead = true; continue; }
        const t2 = planTrtc(trtc, trtcGraph, { from: tid, to, min: j.arr + L.walkMin, holiday });
        if (!t2) continue;
        cands.push({ L, tid, j, t2, arr: j.arr + L.walkMin + t2.totalMin, dep: j.dep });
      }
    }
  }
  if (!cands.length) {
    box.innerHTML = fcBanner + `<div class="panel empty-card">${mrtDead ? t("cantMake") : t("noneFound")}</div>`;
    renderLineMap(null);
    return;
  }
  cands.sort((a, b) => a.arr - b.arr);
  const best = cands[0];
  const mrtFare = fares?.[`${best.L.a}|${fromT ? to : from}`] ?? fares?.[`${fromT ? to : from}|${best.L.a}`];
  const tFare = trtcFares?.[`${fromT ? from : to}|${best.tid}`] ?? trtcFares?.[`${best.tid}|${fromT ? from : to}`];
  const total = (mrtFare ?? 0) + (tFare ?? 0);
  const walkRow = `
    <div class="transfer-row"><span><b>${best.L.trtcNames[0]}</b> ${t("viaLink", "")}${t("walkN", best.L.walkMin)}${best.L.note?.[lang === "zh" ? "zh" : "en"] ? ` · ${best.L.note[lang === "zh" ? "zh" : "en"]}` : ""}</span></div>`;

  let inner;
  if (fromT) {
    inner = trtcLegsHtml(best.t1, ctx.min) + walkRow + best.j.legs.map((l, i) => legHtml(l, best.j, i)).join("");
  } else {
    inner = best.j.legs.map((l, i) => legHtml(l, best.j, i)).join("").replace(/<div class="alight-row">[\s\S]*?<\/div>\s*$/, "") + `
      <div class="alight-row"><span class="leg-time">${fmtTime(best.j.arr)}</span><span class="leg-stations">${stnLabel(best.L.a)} ${t("arriveAt")}</span></div>` +
      walkRow + trtcLegsHtml(best.t2, best.j.arr + best.L.walkMin);
  }
  const legsCount = (fromT ? best.t1.legs.length + best.j.legs.length : best.j.legs.length + best.t2.legs.length);
  box.innerHTML = fcBanner + (fromT ? trtcLastWarn(best.t1, ctx.min, holiday) : "") + `
  <article class="panel journey-card best">
    <div class="jc-head">
      <span class="jc-badge">${t("fastest")}</span>
      <span class="jc-times">${fmtTime(best.dep)}<span class="jc-arrow">▶</span><span class="arr">~${fmtTime(best.arr)}</span></span>
      <span class="jc-meta"><b>${Math.round(best.arr - best.dep)} ${t("min")}</b> · ${t("transfersN", legsCount - 1)}
        ${total ? ` · <span class="fare-chip">${t("totalFare", total)}</span>` : ""}</span>
    </div>
    <div class="legs">${inner}</div>
    <p class="map-hint">${t("estNote")}</p>
  </article>`;
  renderLineMap(fromT ? best.j : null);
}

/* ---------- 呈現 ---------- */
function transferHint(stationId, fromDir, toDir) {
  const s = stationById.get(stationId);
  if (fromDir === toDir) return t("samePlatform");
  const sec = s.transferReverseSec ?? network.defaultTransferReverseSec ?? 150;
  return sec <= 90 ? t("sameReverse") : "";
}

function legHtml(leg, journey, i) {
  const detail = [leg.dir === "S" ? t("towardS") : t("towardN"),
    leg.hops === 1 ? t("nextStop") : leg.type === "express" ? t("skipNote") : t("stopsVia", leg.hops - 1),
    t("rideN", Math.round(leg.arr - leg.dep))].join(" · ");
  let html = `
    <div class="leg ${leg.type}">
      <div class="leg-rail"></div>
      <div class="leg-body">
        <div class="leg-line1">
          <span class="train-chip">${t(leg.type)}</span>
          <span class="leg-time">${fmtTime(leg.dep)}</span>
          <span class="leg-stations">${stnLabel(leg.from)} ${t("boardAt")}</span>
        </div>
        <div class="leg-detail">${detail}</div>
      </div>
    </div>`;
  const next = journey.legs[i + 1];
  if (next) {
    const hint = transferHint(leg.to, leg.dir, next.dir);
    html += `
      <div class="transfer-row">
        <span><b>${stnLabel(leg.to)}</b>（${fmtTime(leg.arr)}）${t("transfer")} · ${t("waitN", Math.round(next.dep - leg.arr))}</span>
        ${hint ? `<span class="same-platform">${hint}</span>` : ""}
      </div>`;
  } else {
    html += `
      <div class="alight-row">
        <span class="leg-time">${fmtTime(leg.arr)}</span>
        <span class="leg-stations">${stnLabel(leg.to)} ${t("arriveAt")}</span>
      </div>`;
  }
  return html;
}

function journeyCard(j, { badge, badgeAlt, saveMin, nextDay, fare, isLast } = {}) {
  const total = Math.round(j.arr - j.dep);
  return `
  <article class="panel journey-card ${badgeAlt ? "" : "best"}">
    <div class="jc-head">
      <span class="jc-badge ${badgeAlt ? "alt" : ""}">${badge}</span>
      ${isLast ? `<span class="last-chip">⚠ ${t("lastTrain")}</span>` : ""}
      ${badgeAlt ? "" : `<button class="cal-btn" id="btn-cal" title="${t("addCal")}">⏰</button><button class="cal-btn" id="btn-share" title="${t("share")}">📤</button>`}
      ${nextDay ? `<span class="nextday-chip">${t("tomorrow")} ${nextDay.slice(5).replace("-", "/")}</span>` : ""}
      <span class="jc-times">${fmtTime(j.dep)}<span class="jc-arrow">▶</span><span class="arr">${fmtTime(j.arr)}</span></span>
      <span class="jc-meta"><b>${total} ${t("min")}</b> · ${j.transfers ? t("transfersN", j.transfers) : t("noTransfer")}
        ${saveMin > 0 ? ` · <span class="save-chip">${t("faster", saveMin)}</span>` : ""}
        ${fare ? ` · <span class="fare-chip">${t("fare", fare)}</span>` : ""}</span>
    </div>
    <div class="legs">${j.legs.map((l, i) => legHtml(l, j, i)).join("")}</div>
  </article>`;
}

function hsrPanel(arrMinAtA18, ctx) {
  if (!hsr) return "";
  const dow = (dowOf(ctx.date) + 6) % 7; // 0=Mon
  const groups = { 1: [], 0: [] }; // 1=北上 0=南下
  for (const tr of hsr) {
    if (!tr.days[dow]) continue;
    const dep = Number(tr.dep.slice(0, 2)) * 60 + Number(tr.dep.slice(3));
    if (dep >= arrMinAtA18 % 1440 + 8 && groups[tr.dir].length < 3) groups[tr.dir].push(tr);
  }
  if (!groups[0].length && !groups[1].length) return "";
  const row = (dirKey, label) => groups[dirKey].length
    ? `<div class="hsr-row"><span class="hsr-dir">${label}</span>${groups[dirKey]
        .map((x) => `<span class="hsr-train"><b>${x.dep}</b> ${t("hsrDest", x.to?.[lang] ?? x.to?.zh ?? "")}</span>`).join("")}</div>`
    : "";
  return `
  <aside class="panel hsr-panel">
    <h3>🚄 ${t("hsrTitle")}</h3>
    ${row(1, t("hsrNorth"))}${row(0, t("hsrSouth"))}
    <p class="hsr-note">${t("hsrNote")}</p>
  </aside>`;
}

function renderResults({ options = [], direct, nextDay, error, arriveMode, cantMake, ctx }) {
  const box = $("results");
  if (error) { box.innerHTML = `<div class="panel empty-card">${error}</div>`; renderLineMap(null); return; }
  if (!options.length) { box.innerHTML = `<div class="panel empty-card">${t("noneFound")}</div>`; renderLineMap(null); return; }

  const best = options[0];
  const fare = fares?.[`${state.from}|${state.to}`] ?? fares?.[`${state.to}|${state.from}`];
  // 末班警示：該日別在此班之後已無可達班次
  let isLast = false;
  if (!nextDay) {
    try {
      const probeDay = dayTypeOf(shiftDate(ctx?.date ?? taipeiNow().date, best.dayOffset ?? 0));
      isLast = !planJourney(getIndex(probeDay), { from: state.from, to: state.to, departAfter: best.dep + 0.5 });
    } catch { /* 無該日別班表 */ }
  }
  let html = "";
  const fc = state.flightCtx;
  if (fc && (state.to === "A12" || state.to === "A13")) {
    const isDep = fc.kind !== "arr";
    // 行李託運截止倒數（起飛前 60 分）
    let bagHtml = "";
    if (isDep && ctx) {
      const now = taipeiNow();
      const closeMin = Number(fc.st.slice(0, 2)) * 60 + Number(fc.st.slice(3)) - 60;
      const left = fc.date === now.date ? Math.round(closeMin - now.min) : null;
      if (left !== null && left <= 0) bagHtml = `<span class="fl-tag bag warn">${t("bagClosed")}</span>`;
      else if (left !== null) bagHtml = `<span class="fl-tag bag ${left < 30 ? "warn" : ""}">${t("bagDeadline", fmtTime(closeMin), left)}</span>`;
    }
    const dMin = flightDelayMin(fc);
    const delayHtml = Math.abs(dMin) >= 15
      ? `<span class="fl-tag bag warn">${t(dMin > 0 ? "flightDelayed" : "flightEarly", Math.abs(dMin))}</span>` +
        (fc.replanned ? "" : `<button class="fl-go" id="btn-replan">${t("replanBtn")}</button>`)
      : "";
    // A1 市區預辦登機判斷（依 data/itci.json 支援航空與時段；僅從 A1 出發時相關）
    let itciHtml = "";
    if (isDep && itci && state.from === "A1") {
      if (!itci.airlines.includes(fc.f.slice(0, 2))) itciHtml = `<span class="fl-tag">${t("itciNo")}</span>`;
      else {
        const now = taipeiNow();
        const dep = hm2min(fc.st);
        const usable = fc.date === now.date
          ? now.min >= hm2min(itci.open) && now.min <= hm2min(itci.close) && now.min <= dep - itci.cutoffMin
          : dep >= hm2min(itci.open) + itci.cutoffMin;
        itciHtml = `<span class="fl-tag ${usable ? "bag" : ""}">${t(usable ? "itciOk" : "itciLate")}</span>`;
      }
    }
    html += `
    <aside class="panel flight-banner">
      <span class="fl-no">✈ ${fc.f}</span>${fc.sched ? `<span class="nextday-chip">${fc.date.slice(5).replace("-", "/")}</span>` : ""}<span class="b-time">${fc.st}</span><span class="fl-dest">${isDep ? "→" : "←"} ${fc.o}</span>
      <span class="fl-tag term">${t("terminalL")} ${fc.term} · ${t("alightAt", stnLabel(state.to))}</span>
      ${isDep && fc.ck ? `<span class="fl-tag ck">${t("counterL")} ${fc.ck}</span>` : ""}
      ${isDep && fc.sched ? `<span class="fl-tag">${t("counterTba")}</span>` : ""}
      ${!isDep && fc.belt ? `<span class="fl-tag ck">${t("beltL")} ${fc.belt}</span>` : ""}
      ${isDep && fc.gate ? `<span class="fl-tag">${t("gateL")} ${fc.gate}</span>` : ""}
      ${bagHtml}${delayHtml}${itciHtml}
      <a class="fl-tag mile-link" href="https://chung223.github.io/as-jx/#flight=${encodeURIComponent(fc.f)}" target="_blank" rel="noopener">${t("mileTools")}</a>
      ${isDep && fc.ck ? counterMapSvg(fc.term, fc.ck) : ""}
      <span class="fl-note">${t(isDep ? "flightPlanNote" : "pickupNote")}</span>
    </aside>`;
  }
  // 🚄 聯程反推：搭高鐵到桃園轉機捷趕飛機（出發站可選、記住偏好）
  lastEb = null;
  if (fc && fc.kind !== "arr" && state.from === "A18" && thsrStations) {
    const mrtDepMin = best.dep % 1440;
    const dateKey = fc.date ?? ctx?.date ?? taipeiNow().date;
    const origin = state.thsrFrom !== TY ? state.thsrFrom : "1000";
    const opts = thsrStations.filter((s) => s.id !== TY).map((s) =>
      `<option value="${s.id}" ${s.id === origin ? "selected" : ""}>${lang === "zh" ? s.zh : s.en || s.zh}</option>`).join("");
    let body = "";
    if (thsrTT?.[dateKey]) {
      const feed = thsrTrips(dateKey, origin, TY)
        .filter((x) => hm2min(x.arr) <= mrtDepMin - 10)
        .slice(-2)
        .reverse();
      const hsrFare = thsrFares?.[`${origin}|${TY}`];
      body = feed.length
        ? feed.map((x, i) => {
            const seats = seatFor(origin, x.no, TY);
            return `<div class="feeder-row ${i === 0 ? "best" : ""}">
              <span class="b-time">${x.dep}</span><span class="jc-arrow">▶</span><span class="b-time arr-t">${x.arr}</span>
              <span class="fl-dest">${t("trainNoL", x.no)}</span>
              ${dateKey === taipeiNow().date ? seatChip(seats?.[0], t("seatStd")) + seatChip(seats?.[1], t("seatBiz")) : ""}
              ${i === 0 && hsrFare && fare ? `<span class="fare-chip">${t("totalFare", hsrFare + fare)}</span>` : ""}
            </div>`;
          }).join("")
        : `<div class="feeder-row none">${t("feederNone")}</div>`;
    } else {
      body = `<div class="feeder-row none">${t("feederFuture")}</div>`;
    }
    const eb = earlyBirdInfo(dateKey);
    if (eb) {
      lastEb = eb.opens ? { opens: eb.opens, travel: dateKey } : null;
      body += `<div class="feeder-row eb">${eb.open ? t("earlyBirdOpen") : t("earlyBird", eb.opens)}${eb.opens ? `<button class="cal-btn" id="btn-eb" title="${t("addCal")}">⏰</button>` : ""}</div>`;
    }
    html += `
    <aside class="panel flight-banner feeder-panel">
      <span class="fl-no">${t("hsrFeederTitle")}</span>
      <select id="feeder-from" class="dt-input sm">${opts}</select>
      <div class="feeder-body">${body}</div>
      <span class="fl-note">${t("feederNote")}</span>
    </aside>`;
  }
  // 🚄 趕高鐵情境橫幅
  const hc = state.hsrCtx;
  if (hc && state.to === "A18" && !fc) {
    html += `
    <aside class="panel flight-banner">
      <span class="fl-no">🚄</span><span class="b-time">${hc.dep}</span>
      <span class="fl-dest">${t("hsrDest", hc.to?.[lang] ?? hc.to?.zh ?? "")}</span>
      <span class="fl-tag term">${hc.dir === 1 ? t("hsrNorth") : t("hsrSouth")} · ${t("alightAt", stnLabel("A18"))}</span>
      <span class="fl-note">${t("hsrPlanNote")}</span>
    </aside>`;
  }
  if (nextDay) html += `<div class="panel empty-card">${t("noServiceToday")}</div>`;
  if (cantMake) html += `<div class="panel empty-card">${t("cantMake")}</div>`;

  if (arriveMode) {
    html += journeyCard(best, { badge: t("latestDep"), fare, isLast });
    for (const o of options.slice(1)) html += journeyCard(o, { badge: t("nextCard"), badgeAlt: true });
  } else {
    const directIsBest = direct && direct.dep === best.dep && direct.arr === best.arr && best.transfers === 0;
    const saveMin = direct ? Math.round(abs(direct) - abs(best)) : 0;
    html += journeyCard(best, { badge: t("fastest"), saveMin, nextDay, fare, isLast });
    if (direct && !directIsBest && best.transfers > 0) html += journeyCard(direct, { badge: t("directCard"), badgeAlt: true, nextDay });
    const rest = options.slice(1).filter((o) => !(direct && o.dep === direct.dep && o.arr === direct.arr && o.transfers === 0));
    if (rest.length) {
      html += `<h3 class="options-title">${t("nextCard")}</h3>`;
      for (const o of rest) html += journeyCard(o, { badge: t("nextCard"), badgeAlt: true, nextDay });
    }
  }

  // TPASS 定期票回本試算（票價與定期票資料齊備時）
  if (fare && passes) {
    for (const p of passes) {
      const trips = Math.ceil(p.price / fare);
      html += `<aside class="panel tip-card tpass-card">💳 ${t("tpassNote", p.name?.[lang] ?? p.name?.zh ?? p.id, p.price, fare, trips)}</aside>`;
    }
  }

  // A18 高鐵接駁
  const a18 = best.legs.find((l) => l.to === "A18") ?? (state.to === "A18" ? best.legs[best.legs.length - 1] : null);
  if (a18 && ctx) html += hsrPanel(a18.arr, ctx);
  // 機場預辦登機提示（有航班情境時已在橫幅顯示個別判斷，不重複）
  if ((state.to === "A12" || state.to === "A13") && !(fc && fc.kind !== "arr" && itci)) html += `<aside class="panel tip-card">${t("checkinTip")}</aside>`;

  box.innerHTML = html;
  renderLineMap(best);
  const calBtn = $("btn-cal");
  if (calBtn) calBtn.onclick = () => addReminder(best, ctx, calBtn);
  const feederSel = $("feeder-from");
  if (feederSel) feederSel.onchange = () => {
    state.thsrFrom = feederSel.value;
    localStorage.setItem("trav-hsr-from", state.thsrFrom);
    runQuery();
  };
  const ebBtn = $("btn-eb");
  if (ebBtn && lastEb) ebBtn.onclick = () => {
    earlyBirdIcs(lastEb.opens, lastEb.travel);
    ebBtn.textContent = "✓";
    setTimeout(() => (ebBtn.textContent = "⏰"), 2500);
  };
  const shareBtn = $("btn-share");
  if (shareBtn) shareBtn.onclick = () => shareCard(best, ctx, fare, shareBtn);
  const replanBtn = $("btn-replan");
  if (replanBtn && fc) replanBtn.onclick = () => {
    const et = Number(fc.et.slice(0, 2)) * 60 + Number(fc.et.slice(3));
    const now = taipeiNow();
    const target = fc.kind === "arr" ? Math.max(et, now.min + 1) : Math.max(et - 150, now.min + 1);
    fc.replanned = true;
    state.custom = `${fc.date}T${fmtTime(target)}`;
    $("custom-time").value = state.custom;
    setMode("arrive");
  };
  if (fc && !fc.replanned) refreshFlightEt(fc);
}

/* ---------- 🚨 營運異常警示（高鐵／機捷，正常時隱藏） ---------- */
function renderAlerts() {
  const el = $("alert-strip");
  if (!sysAlerts.length) { el.hidden = true; return; }
  el.innerHTML = sysAlerts.slice(0, 3).map((a) =>
    `<span class="al-item">⚠ <b>${t("alertL")[a.sys] ?? a.sys}</b> ${a.title}</span>`
  ).join("");
  el.hidden = false;
}

/* ---------- 🎫 高鐵早鳥開賣提醒（出發前 28 天開賣） ---------- */
function earlyBirdInfo(travelDate) {
  const today = taipeiNow().date;
  if (!travelDate || travelDate <= today) return null;
  const opens = shiftDate(travelDate, -28);
  return opens > today ? { opens } : { open: true };
}
function earlyBirdIcs(opens, travelDate) {
  const d = opens.replaceAll("-", "");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//tymetrofast//TW", "BEGIN:VEVENT",
    `UID:tymf-eb-${d}@tymetrofast`,
    `DTSTART;TZID=Asia/Taipei:${d}T000000`, `DTEND;TZID=Asia/Taipei:${d}T003000`,
    `SUMMARY:🎫 高鐵早鳥開賣（${travelDate} 行程）`,
    `DESCRIPTION:出發日 ${travelDate} 的高鐵早鳥票今日 00:00 開賣（最低 65 折、售完為止）`,
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:🎫 高鐵早鳥開賣", "TRIGGER:PT9H", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `hsr-earlybird-${opens}.ics`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 🧭 報到櫃台分區示意（data/terminals.json 可編輯） ---------- */
function counterMapSvg(term, ck) {
  const tz = terminals?.[String(term).match(/\d/)?.[0]];
  if (!tz?.zones?.length || !ck) return "";
  const hl = new Set();
  const range = String(ck).match(/(\d+)\s*[-–~]\s*(\d+)/);
  if (range) { for (let i = Number(range[1]); i <= Number(range[2]); i++) hl.add(String(i)); }
  else { const single = String(ck).match(/\d+/); if (single) hl.add(single[0]); }
  if (![...hl].some((z) => tz.zones.includes(z))) return "";
  const W = 340, bw = (W - 20) / tz.zones.length;
  let g = `<text x="8" y="12" font-size="9.5" font-weight="700" fill="var(--text-dim)">${tz.note?.[lang === "zh" ? "zh" : "en"] ?? ""}</text>`;
  tz.zones.forEach((z, i) => {
    const x = 10 + i * bw, on = hl.has(z);
    g += `<rect x="${(x + 1).toFixed(1)}" y="17" width="${(bw - 2).toFixed(1)}" height="22" rx="4" fill="${on ? "var(--amber)" : "var(--ink)"}" stroke="${on ? "var(--amber)" : "var(--line-strong)"}" stroke-width="1"/>`;
    g += `<text x="${(x + bw / 2).toFixed(1)}" y="32" text-anchor="middle" font-size="10.5" font-weight="${on ? 900 : 600}" fill="${on ? "var(--sign-bg)" : "var(--text-dim)"}" font-family="Chakra Petch, sans-serif">${z}</text>`;
  });
  g += `<text x="8" y="53" font-size="8.5" fill="var(--text-dim)" opacity="0.8">${t("counterMapNote")}</text>`;
  return `<svg class="ck-map" viewBox="0 0 ${W} 58" role="img" aria-label="check-in zones">${g}</svg>`;
}

/* ---------- ✈ 班機延誤：預估時刻與表定差距、自動追蹤 ---------- */
function flightDelayMin(fc) {
  if (!fc?.et || !fc.st || fc.et === fc.st) return 0;
  const m = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  let d = m(fc.et) - m(fc.st);
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
}
async function refreshFlightEt(fc) {
  try {
    const data = await loadFids();
    const row = (data.airports?.TPE?.[fc.kind] ?? []).find((r) => r.f === fc.f && r.st === fc.st);
    if (!row) return;
    const et = row.et || "";
    if (et !== (fc.et ?? "") && state.flightCtx === fc && state.view === "plan") {
      fc.et = et;
      runQuery();
    }
  } catch { /* 離線時略過 */ }
}

/* ---------- 📤 行程分享卡（canvas → PNG） ---------- */
let qrMod = null, lastEb = null;
async function shareCard(j, ctx, fare, btn) {
  try { await Promise.all(["400 40px DotGothic16", "700 17px 'Noto Sans TC'", "900 21px 'Noto Serif TC'"].map((f) => document.fonts.load(f))); } catch { /* 字型未載入時退回系統字 */ }
  const W = 420, X = 28;
  const fc = state.flightCtx, hc = state.hsrCtx;
  const legRows = j.legs.length * 44 + (j.legs.length - 1) * 26;
  const H = 208 + (fc || hc ? 30 : 0) + legRows + 30 + 118;
  const cv = document.createElement("canvas");
  const S = 2;
  cv.width = W * S; cv.height = H * S;
  const c = cv.getContext("2d");
  c.scale(S, S);
  const dash = (y) => {
    c.save(); c.strokeStyle = "rgba(212,175,110,.3)"; c.lineWidth = 1; c.setLineDash([5, 6]);
    c.beginPath(); c.moveTo(16, y); c.lineTo(W - 16, y); c.stroke(); c.restore();
  };
  c.fillStyle = "#16120c"; c.fillRect(0, 0, W, H);
  const grad = c.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "#8e4e9e"); grad.addColorStop(1, "#3c6e9e");
  c.fillStyle = grad; c.fillRect(0, 0, W, 6);
  c.strokeStyle = "rgba(212,175,110,.35)"; c.lineWidth = 1.5;
  c.strokeRect(8, 14, W - 16, H - 22);
  c.fillStyle = "#d4af6e"; c.font = "900 21px 'Noto Serif TC', 'Noto Sans TC', serif";
  c.fillText("快轉", X, 48);
  c.fillStyle = "#a29377"; c.font = "600 9px 'Chakra Petch', sans-serif";
  c.fillText(`${t("shareTicket")} · TAOYUAN AIRPORT MRT`, X, 62);
  c.textAlign = "right"; c.font = "600 12px 'Chakra Petch', sans-serif";
  c.fillText(ctx?.date ?? taipeiNow().date, W - X, 48);
  c.textAlign = "left";
  dash(76);
  c.fillStyle = "#f0e8d8"; c.font = "700 17px 'Noto Sans TC', sans-serif";
  c.fillText(`${stnLabel(state.from)} → ${stnLabel(state.to)}`, X, 102);
  c.fillStyle = "#d4af6e"; c.font = "400 38px 'DotGothic16', 'Chakra Petch', monospace";
  c.fillText(fmtTime(j.dep), X, 146);
  const w1 = c.measureText(fmtTime(j.dep)).width;
  c.fillStyle = "#a29377"; c.font = "400 20px 'DotGothic16', monospace";
  c.fillText("▶", X + w1 + 14, 141);
  c.fillStyle = "#8cc1a0"; c.font = "400 38px 'DotGothic16', 'Chakra Petch', monospace";
  c.fillText(fmtTime(j.arr), X + w1 + 44, 146);
  c.fillStyle = "#a29377"; c.font = "500 13px 'Noto Sans TC', sans-serif";
  const meta = [`${Math.round(j.arr - j.dep)} ${t("min")}`, j.transfers ? t("transfersN", j.transfers) : t("noTransfer")];
  if (fare) meta.push(t("fare", fare));
  c.fillText(meta.join("　·　"), X, 172);
  let y = 196;
  if (fc) {
    c.fillStyle = "#7fa8cc"; c.font = "600 13px 'Chakra Petch', 'Noto Sans TC', sans-serif";
    c.fillText(`✈ ${fc.f} ${fc.st} ${fc.kind === "arr" ? "←" : "→"} ${fc.o}${fc.term ? `  T${fc.term}` : ""}${fc.ck ? `  ${t("counterL")} ${fc.ck}` : ""}`, X, y);
    y += 30;
  } else if (hc) {
    c.fillStyle = "#7fa8cc"; c.font = "600 13px 'Chakra Petch', 'Noto Sans TC', sans-serif";
    c.fillText(`🚄 ${hc.dep} ${t("hsrDest", hc.to?.[lang] ?? hc.to?.zh ?? "")}`, X, y);
    y += 30;
  }
  dash(y - 12); y += 14;
  for (let i = 0; i < j.legs.length; i++) {
    const l = j.legs[i];
    c.fillStyle = l.type === "express" ? "#b995d8" : "#7fa8cc";
    c.beginPath(); c.arc(X + 6, y - 5, 5, 0, 7); c.fill();
    c.fillStyle = "#f0e8d8"; c.font = "700 14.5px 'Noto Sans TC', sans-serif";
    c.fillText(`${fmtTime(l.dep)}  ${stnName(l.from)}`, X + 22, y);
    c.fillStyle = "#a29377"; c.font = "500 11.5px 'Noto Sans TC', sans-serif";
    c.fillText(`${t(l.type)} · ${l.dir === "S" ? t("towardS") : t("towardN")} · ${t("rideN", Math.round(l.arr - l.dep))}`, X + 22, y + 17);
    y += 44;
    const nx = j.legs[i + 1];
    if (nx) {
      c.fillStyle = "#d4af6e"; c.font = "500 12px 'Noto Sans TC', sans-serif";
      c.fillText(`⇄ ${fmtTime(l.arr)} ${stnName(l.to)} ${t("transfer")} · ${t("waitN", Math.round(nx.dep - l.arr))}`, X + 22, y - 12);
      y += 26;
    }
  }
  const last = j.legs[j.legs.length - 1];
  c.fillStyle = "#8cc1a0";
  c.beginPath(); c.arc(X + 6, y - 5, 5, 0, 7); c.fill();
  c.font = "700 14.5px 'Noto Sans TC', sans-serif";
  c.fillText(`${fmtTime(last.arr)}  ${stnName(last.to)}  ${t("arriveAt")}`, X + 22, y);
  dash(y + 16);
  // 掃碼開同一行程（分享頁帶 OG 預覽；QR 產生器載入失敗就只留網址）
  const link = `${SITE_URL}s/${state.from}-${state.to}.html?m=depart&t=${ctx?.date ?? taipeiNow().date}T${fmtTime(j.dep)}`;
  try {
    qrMod ??= (await import("./qrcode.mjs")).default;
    const qr = qrMod(0, "M");
    qr.addData(link);
    qr.make();
    const n = qr.getModuleCount();
    const qsize = 72, cell = qsize / n, qx = W - X - qsize, qy = y + 30;
    c.fillStyle = "#f0e8d8";
    c.fillRect(qx - 6, qy - 6, qsize + 12, qsize + 12);
    c.fillStyle = "#16120c";
    for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) if (qr.isDark(r, q)) c.fillRect(qx + q * cell, qy + r * cell, Math.ceil(cell), Math.ceil(cell));
  } catch { /* 離線或載入失敗 */ }
  c.fillStyle = "#7b6d55"; c.font = "500 10px 'Chakra Petch', sans-serif";
  c.fillText("chung223.github.io/tymetrofast", X, y + 70);
  cv.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], `mrt-${fmtTime(j.dep).replace(":", "")}.png`, { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "快轉", url: link }); return; }
      catch (e) { if (e?.name === "AbortError") return; /* 其他失敗改走下載 */ }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(a.href);
  }, "image/png");
  btn.textContent = "✓";
  setTimeout(() => (btn.textContent = "📤"), 2500);
}

/* ---------- ⏰ 提醒：行事曆 .ics ＋ 頁面開啟時的通知 ---------- */
function addReminder(j, ctx, btn) {
  const date = (ctx?.date ?? taipeiNow().date).replaceAll("-", "");
  const dt = (m) => `${date}T${fmtTime(m).replace(":", "")}00`;
  const fc = state.flightCtx;
  const desc = [
    ...(fc ? [`✈ ${fc.f} ${fc.st} ${fc.kind === "arr" ? "←" : "→"} ${fc.o}` +
      (fc.term ? ` / ${t("terminalL")} ${fc.term}` : "") +
      (fc.ck ? ` / ${t("counterL")} ${fc.ck}` : "") +
      (fc.belt ? ` / ${t("beltL")} ${fc.belt}` : "")] : []),
    `${stnLabel(state.from)} → ${stnLabel(state.to)}`,
  ];
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//tymetrofast//TW", "BEGIN:VEVENT",
    `UID:tymf-${date}-${Math.round(j.dep)}@tymetrofast`,
    `DTSTART;TZID=Asia/Taipei:${dt(j.dep)}`, `DTEND;TZID=Asia/Taipei:${dt(j.arr)}`,
    `SUMMARY:🚇 ${fmtTime(j.dep)} ${stnName(state.from)} → ${stnName(state.to)}`,
    `DESCRIPTION:${desc.join("\\n")}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:🚇 ${fmtTime(j.dep)}`, "TRIGGER:-PT15M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = `mrt-${fmtTime(j.dep).replace(":", "")}.ics`;
  a.click();
  URL.revokeObjectURL(a.href);
  // 頁面保持開啟時的補充通知（發車前 15 分鐘）
  const now = taipeiNow();
  const fireInMs = (j.dep - 15 - now.min) * 60000;
  if ((ctx?.date ?? now.date) === now.date && fireInMs > 0 && fireInMs < 12 * 3600000 && "Notification" in window) {
    Notification.requestPermission().then((p) => {
      if (p !== "granted") return;
      setTimeout(() => new Notification(`🚇 ${fmtTime(j.dep)} ${stnName(state.from)} → ${stnName(state.to)}`, {
        body: fc ? `✈ ${fc.f}${fc.ck ? ` · ${t("counterL")} ${fc.ck}` : ""}` : t("addCal"),
        icon: "icons/icon-192.png",
      }), fireInMs);
    });
  }
  btn.textContent = "✓";
  btn.title = t("notifSet");
  setTimeout(() => { btn.textContent = "⏰"; btn.title = t("addCal"); }, 3000);
}

/* ---------- 路線圖（示意 / 地理）＋列車位置模擬 ---------- */
let mapView = localStorage.getItem("tymf-map") ?? "schematic";
let lastJourney = null, mapCtx = null;
const stnIdx = new Map(stations.map((s, i) => [s.id, i]));

function renderLineMap(journey) {
  lastJourney = journey;
  if (mapView === "geo" && geo) renderGeoMap(journey);
  else renderSchematic(journey);
  $("map-toggle").textContent = mapView === "geo" ? t("mapSchematic") : t("mapGeo");
}

/* 版面抽象：pt(f) 把「小數站序」轉成座標。窄螢幕用兩排蛇形（車廂路線圖式），
 * A1–A11 上排左→右、A12–A22 下排右→左，右側 U 型彎道以圓弧內插。 */
function schematicLayout(W) {
  const n = stations.length;
  if (W >= 560) {
    const PAD = 26, Y = 40;
    const step = (W - PAD * 2) / (n - 1);
    return { W, H: 104, snake: false, half: n, pt: (f) => ({ x: PAD + f * step, y: Y }) };
  }
  const half = Math.ceil(n / 2);
  const Y1 = 46, Y2 = 132, r = (Y2 - Y1) / 2, cy = (Y1 + Y2) / 2;
  const xL = 18, xR = W - r - 12;
  const step = (xR - xL) / (half - 1);
  return {
    W, H: 162, snake: true, half,
    pt: (f) => {
      if (f <= half - 1) return { x: xL + f * step, y: Y1 };
      if (f >= half) return { x: xR - (f - half) * step, y: Y2 };
      const th = -Math.PI / 2 + (f - half + 1) * Math.PI;
      return { x: xR + r * Math.cos(th), y: cy + r * Math.sin(th) };
    },
  };
}

/* 沿路徑取點；off 為對行進軸的垂直偏移（南下正、北上負＝雙軌意象） */
function ptOff(L, f, off) {
  const p = L.pt(f);
  if (!off) return p;
  const a = L.pt(Math.max(0, f - 0.05)), b = L.pt(Math.min(stations.length - 1, f + 0.05));
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: p.x - ((b.y - a.y) / len) * off, y: p.y + ((b.x - a.x) / len) * off };
}
function samplePts(L, f1, f2, off = 0) {
  const steps = Math.max(2, Math.ceil(Math.abs(f2 - f1) * 4));
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const p = ptOff(L, f1 + ((f2 - f1) * k) / steps, off);
    pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }
  return pts.join(" ");
}

function legsSvg(L, journey) {
  if (!journey) return "";
  let g = "";
  const dir0 = journey.legs[0].dir;
  for (const leg of journey.legs) {
    const f1 = stnIdx.get(leg.from), f2 = stnIdx.get(leg.to);
    const off = leg.dir === dir0 ? 0 : leg.dir === "N" ? -7 : 7;
    const color = leg.type === "express" ? "var(--purple)" : "var(--blue)";
    const pts = samplePts(L, f1, f2, off);
    g += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>`;
    g += `<polyline class="flow" points="${pts}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    const fm = (f1 + f2) / 2;
    const p = ptOff(L, fm, off), pa = L.pt(Math.max(0, fm - 0.1)), pb = L.pt(Math.min(stations.length - 1, fm + 0.1));
    const ang = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI + (f2 < f1 ? 180 : 0);
    g += `<polygon points="-5,-4 -5,4 4,0" fill="var(--ink)" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${ang.toFixed(1)})"/>`;
  }
  return g;
}

/* 依時刻表模擬目前每班車在路線上的位置（站序線性內插） */
function trainDotsSvg(L) {
  const now = taipeiNow();
  let g = "";
  const scan = (dayType, off) => {
    let idx;
    try { idx = getIndex(dayType); } catch { return; }
    for (const tr of idx.trainById.values()) {
      const st = tr.stops;
      if (now.minF < st[0][1] + off || now.minF > st[st.length - 1][1] + off) continue;
      let k = 0;
      while (k < st.length - 2 && st[k + 1][1] + off <= now.minF) k++;
      const span = st[k + 1][1] - st[k][1] || 1;
      const prog = Math.min(1, Math.max(0, (now.minF - st[k][1] - off) / span));
      const fi = stnIdx.get(st[k][0]) + prog * (stnIdx.get(st[k + 1][0]) - stnIdx.get(st[k][0]));
      const p = ptOff(L, fi, tr.dir === "S" ? 4.5 : -4.5);
      g += `<circle class="train-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.4" fill="${tr.type === "express" ? "var(--purple)" : "var(--blue)"}" stroke="var(--ink)" stroke-width="1.2"/>`;
    }
  };
  scan(dayTypeOf(now.date), 0);
  if (now.minF < 180) scan(dayTypeOf(shiftDate(now.date, -1)), -1440);
  return g;
}

function journeyMarksSvg(L, journey) {
  if (!journey) return "";
  let g = "";
  const marks = new Map();
  marks.set(journey.legs[0].from, "起");
  journey.legs.forEach((l, i) => i < journey.legs.length - 1 && marks.set(l.to, "轉"));
  marks.set(journey.legs[journey.legs.length - 1].to, "訖");
  const sorted = [...marks].sort((a, b) => stnIdx.get(a[0]) - stnIdx.get(b[0]));
  const tiers = {};
  for (const [id, kind] of sorted) {
    const i = stnIdx.get(id);
    const { x, y } = L.pt(i);
    const row = L.snake && i >= L.half ? "b" : "t";
    const prev = tiers[row];
    const tier = prev && Math.abs(x - prev.x) < 88 && prev.tier === 1 ? 2 : 1;
    tiers[row] = { x, tier };
    const tx = Math.min(Math.max(x, 44), L.W - 44);
    // 蛇形上排的第二層改往下疊（上方會撞到地圖切換鈕）
    const ty = tier === 1 ? y - 12 : L.snake && row === "t" ? y + 31 : y - 26;
    g += `<text x="${tx}" y="${ty}" text-anchor="middle" font-size="11" font-weight="700" font-family="Noto Sans TC, sans-serif" fill="${kind === "轉" ? "var(--amber)" : "var(--green)"}">${stnName(id)}</text>`;
  }
  return g;
}

function renderSchematic(journey) {
  const svg = $("line-map");
  const scroller = svg.closest(".line-map-scroll");
  const cw = scroller.clientWidth || 690;
  const L = schematicLayout(cw < 560 ? cw : Math.max(690, cw));
  svg.classList.toggle("snake", L.snake);
  let g = `<polyline points="${samplePts(L, 0, stations.length - 1)}" fill="none" stroke="var(--rail)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
  g += legsSvg(L, journey);
  stations.forEach((s, i) => {
    const { x, y } = L.pt(i);
    const inJourney = journey && journey.legs.some((l) => l.from === s.id || l.to === s.id);
    const fill = inJourney ? "var(--amber)" : "#fff";
    const dim = inJourney ? "var(--amber)" : "var(--text-dim)";
    g += `<circle cx="${x.toFixed(1)}" cy="${y}" r="${s.express ? (L.snake ? 5 : 6) : (L.snake ? 3.8 : 4.5)}" fill="${fill}" stroke="${s.express ? "var(--purple)" : "var(--blue)"}" stroke-width="2.5"/>`;
    g += L.snake
      ? `<text x="${x.toFixed(1)}" y="${y + 18}" text-anchor="middle" font-size="8.5" font-family="Chakra Petch, sans-serif" font-weight="600" fill="${dim}">${s.id}</text>`
      : `<text x="${x.toFixed(1)}" y="${y + 22}" transform="rotate(-52 ${x.toFixed(1)} ${y + 22})" text-anchor="end" font-size="10" font-family="Chakra Petch, sans-serif" font-weight="600" fill="${dim}">${s.id}</text>`;
  });
  g += journeyMarksSvg(L, journey);
  g += `<g id="train-dots">${trainDotsSvg(L)}</g>`;
  svg.setAttribute("viewBox", `0 0 ${L.W} ${L.H}`);
  svg.style.height = `${L.H}px`;
  svg.innerHTML = g;
  mapCtx = L;
  if (journey && !L.snake) {
    const xs = journey.legs.flatMap((l) => [L.pt(stnIdx.get(l.from)).x, L.pt(stnIdx.get(l.to)).x]);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    scroller.scrollTo({ left: (mid / L.W) * svg.scrollWidth - scroller.clientWidth / 2, behavior: "smooth" });
  }
}

function renderGeoMap(journey) {
  const svg = $("line-map");
  svg.classList.remove("snake");
  const W = 690, H = 300, PAD = 30;
  const lons = stations.map((s) => geo[s.id][0]), lats = stations.map((s) => geo[s.id][1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const kx = (W - PAD * 2) / (maxLon - minLon);
  const ky = (H - PAD * 2) / (maxLat - minLat);
  const P = stations.map((s) => ({ x: PAD + (geo[s.id][0] - minLon) * kx, y: H - PAD - (geo[s.id][1] - minLat) * ky }));
  const L = {
    W, H, snake: false, half: stations.length,
    pt: (f) => {
      const i = Math.max(0, Math.min(stations.length - 1, f));
      const a = P[Math.floor(i)], b = P[Math.ceil(i)], u = i - Math.floor(i);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    },
  };
  let g = `<polyline points="${P.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" fill="none" stroke="var(--rail)" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
  g += legsSvg(L, journey);
  const KEY = new Set(["A1", "A8", "A12", "A13", "A18", "A21", "A22", state.from, state.to]);
  stations.forEach((s, i) => {
    const inJourney = journey && journey.legs.some((l) => l.from === s.id || l.to === s.id);
    g += `<circle cx="${P[i].x.toFixed(1)}" cy="${P[i].y.toFixed(1)}" r="${s.express ? 5.5 : 4}" fill="${inJourney ? "var(--amber)" : "#fff"}" stroke="${s.express ? "var(--purple)" : "var(--blue)"}" stroke-width="2.5"/>`;
    if (KEY.has(s.id)) {
      const cx = P[i].x;
      const anchor = cx > W - 110 ? "end" : cx < 110 ? "start" : geo[s.id][0] > (minLon + maxLon) / 2 ? "start" : "end";
      g += `<text x="${(cx + (anchor === "start" ? 9 : -9)).toFixed(1)}" y="${(P[i].y + 4).toFixed(1)}" text-anchor="${anchor}" font-size="11" font-weight="700" font-family="Noto Sans TC, sans-serif" fill="${inJourney ? "var(--amber)" : "var(--text-dim)"}">${stnName(s.id)}</text>`;
    }
  });
  g += `<g id="train-dots">${trainDotsSvg(L)}</g>`;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.style.height = "300px";
  svg.innerHTML = g;
  mapCtx = L;
}
let resizeT;
addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (state.view === "plan") renderLineMap(lastJourney); }, 200);
});
$("map-toggle").addEventListener("click", () => {
  mapView = mapView === "geo" ? "schematic" : "geo";
  localStorage.setItem("tymf-map", mapView);
  renderLineMap(lastJourney);
});

/* ---------- 🚇 北捷即時到站看板（Worker 中繼；失敗退回班距推估） ---------- */
let trtcBoardAt = 0;
function trtcHeadwayRows(sid, note) {
  const holiday = dayTypeOf(taipeiNow().date) === "holiday";
  const lines = [...(trtcGraph?.linesAt.get(sid) ?? [])];
  return (note ? `<li class="board-row empty">${note}</li>` : "") + (lines.length
    ? lines.map((l) => `
      <li class="board-row">
        ${lineChip(l)}
        <span class="b-dest">${t("headwayAbout", Math.round(headwayOf(trtc, l, taipeiNow().min, holiday)))}</span>
      </li>`).join("")
    : `<li class="board-row empty">${t("noneFound")}</li>`);
}
// 北捷 LiveBoard 為事件式資料：只列「正在進站」的列車（EstimateTime 恆為 0），
// 無逐站倒數。因此取全網列車位置，沿線用站間行駛時間（含停站）推進，
// 推算查詢站還有幾分鐘到——路線為樹狀（中和新蘆有 Y 岔），以相鄰站尋路避免走錯支線。
const trtcAdjCache = new Map();
function trtcAdj(lineId) {
  if (!trtcAdjCache.has(lineId)) {
    const adj = new Map();
    for (const [a, b, m] of trtc.lines?.[lineId]?.s2s ?? []) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push([b, m]);
      adj.get(b).push([a, m]);
    }
    trtcAdjCache.set(lineId, adj);
  }
  return trtcAdjCache.get(lineId);
}
/** 列車自 from 開往 dest 的唯一路徑若經過 sid，回傳 from→sid 行駛分鐘；否則 null */
function trtcMinAlong(lineId, from, dest, sid) {
  const adj = trtcAdj(lineId);
  if (!adj.has(from) || !adj.has(dest)) return null;
  const prev = new Map([[from, null]]);
  const q = [from];
  while (q.length) {
    const cur = q.shift();
    if (cur === dest) break;
    for (const [nx] of adj.get(cur) ?? []) if (!prev.has(nx)) { prev.set(nx, cur); q.push(nx); }
  }
  if (!prev.has(dest)) return null;
  const path = [];
  for (let c = dest; c != null; c = prev.get(c)) path.unshift(c);
  const i = path.indexOf(sid);
  if (i <= 0) return null;
  let min = 0;
  for (let k = 0; k < i; k++) min += (adj.get(path[k]) ?? []).find(([s]) => s === path[k + 1])?.[1] ?? 2;
  return min;
}
/** 全網即時列 → 查詢站的到站推估（分）；容錯秒制營運商（任一值 >100 視為秒） */
function trtcLiveEta(sid, arr) {
  const isSec = arr.some((x) => x.EstimateTime > 100);
  const toMin = (v) => (v == null ? 0 : isSec ? v / 60 : v);
  const items = [];
  for (const x of arr) {
    const at = x.StationID ?? "";
    const line = String(x.LineID ?? trtcLineOf(at));
    const dest = x.DestinationStationID ?? x.DestinationStaionID ?? "";
    const destName = (lang === "zh" ? x.DestinationStationName?.Zh_tw : x.DestinationStationName?.En)
      ?? x.TripHeadSign ?? dest;
    if (at === sid) { items.push({ line, dest: destName, min: Math.floor(toMin(x.EstimateTime)) }); continue; }
    const ride = trtcMinAlong(line, at, dest, sid);
    if (ride == null) continue;
    const min = Math.round(toMin(x.EstimateTime) + ride);
    if (min <= 25) items.push({ line, dest: destName, min }); // 推得越遠越不準，超過即交給班距推估
  }
  return items.sort((a, b) => a.min - b.min).slice(0, 8);
}
async function renderTrtcBoard(sid) {
  $("board-code").textContent = sid;
  $("board-name").textContent = trtcStnName(sid);
  $("fac-card").hidden = true;
  const holiday = dayTypeOf(taipeiNow().date) === "holiday";
  const fl = (trtc.firstLast?.[sid] ?? []).filter(([, , , , days]) => days[holiday ? 6 : 2] === "1").slice(0, 4);
  $("board-firstlast").innerHTML = fl.map(([line, dest, first, last]) => `
    <span class="fl-cell">${lineChip(trtcLineOf(line))}<b>${dest}</b>
      <span class="flc">${t("firstChip")} <span class="b-time sm">${first}</span></span>
      <span class="flc">${t("lastChip")} <span class="b-time sm">${last}</span></span>
    </span>`).join("");
  const list = $("board-list");
  if (!liveApi) { list.innerHTML = trtcHeadwayRows(sid); return; }
  trtcBoardAt = Date.now();
  try {
    const r = await fetch(`${liveApi}/trtc-live`, { cache: "no-store" });
    if (!r.ok) throw 0;
    const raw = await r.json();
    if (sid !== state.boardStation || state.view !== "board") return; // 使用者已換站
    const items = trtcLiveEta(sid, Array.isArray(raw) ? raw : []);
    list.innerHTML = items.length
      ? items.map((it) => `
        <li class="board-row live">
          <span class="b-count">${it.min < 1 ? t("now") : t("inMin", it.min)}</span>
          ${lineChip(trtcLineOf(String(it.line)))}
          <span class="b-dest">→ ${it.dest}</span>
        </li>`).join("") + `<li class="board-row empty live-note">● ${t("liveNote2")}</li>`
      : trtcHeadwayRows(sid, t("liveNone"));
  } catch {
    if (sid === state.boardStation) list.innerHTML = trtcHeadwayRows(sid, t("liveFail"));
  }
}

/* ---------- 車站看板 ---------- */
// 快捷站鈕：最近查過優先，不足補預設熱門站（機捷＋北捷）；ID 不存在於資料就不顯示
const BOARD_DEFAULTS = ["A1", "A13", "BL12", "BR10", "G12", "O07"];
function rememberBoardStn(id) {
  localStorage.setItem("tymf-board-stn", id);
  const rec = JSON.parse(localStorage.getItem("tymf-board-recent") ?? "[]").filter((x) => x !== id);
  rec.unshift(id);
  localStorage.setItem("tymf-board-recent", JSON.stringify(rec.slice(0, 6)));
}
function renderBoardQuick() {
  const rec = JSON.parse(localStorage.getItem("tymf-board-recent") ?? "[]");
  const ids = [...new Set([...rec, ...BOARD_DEFAULTS])]
    .filter((id) => stationById.has(id) || isTrtc(id))
    .slice(0, 6);
  $("board-quick").innerHTML = ids.map((id) => `
    <button class="bq-chip ${id === state.boardStation ? "cur" : ""}" data-id="${id}">
      <span class="code${isTrtc(id) ? " trtc-code" : ""}"${isTrtc(id) ? ` style="--lc:${TRTC_COLORS[trtcLineOf(id)] ?? "#888"}"` : ""}>${id}</span>${stnName(id)}
    </button>`).join("");
}
$("board-quick").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-id]");
  if (!btn) return;
  state.boardStation = btn.dataset.id;
  rememberBoardStn(btn.dataset.id);
  renderBoard();
});
function renderBoard() {
  const now = taipeiNow();
  renderBoardQuick();
  const sid = state.boardStation;
  if (isTrtc(sid)) { renderTrtcBoard(sid); return; }
  $("board-code").textContent = sid;
  $("board-name").textContent = stnName(sid);
  const rows = [];
  const push = (dayType, offset) => {
    const idx = getIndex(dayType);
    const lastDep = {};
    for (const c of idx.connections) if (c.from === sid) lastDep[c.dir] = Math.max(lastDep[c.dir] ?? -1, c.dep);
    for (const c of idx.connections) {
      if (c.from !== sid) continue;
      const dep = c.dep + offset;
      const dm = dep - now.min;
      if (dm < -0.5 || dm > 120) continue;
      const train = idx.trainById.get(c.trip);
      rows.push({ dep, dm, type: c.type, dir: c.dir, terminal: train.stops[train.stops.length - 1][0], isLast: c.dep === lastDep[c.dir] });
    }
  };
  push(dayTypeOf(now.date), 0);
  if (now.min < 180) push(dayTypeOf(shiftDate(now.date, -1)), -1440);
  // 首末班總覽（當日日別）
  const flIdx = getIndex(dayTypeOf(now.date));
  const fl = { S: [Infinity, -1], N: [Infinity, -1] };
  for (const c of flIdx.connections) {
    if (c.from !== sid) continue;
    fl[c.dir][0] = Math.min(fl[c.dir][0], c.dep);
    fl[c.dir][1] = Math.max(fl[c.dir][1], c.dep);
  }
  $("board-firstlast").innerHTML = ["S", "N"].filter((d) => fl[d][1] >= 0).map((d) => `
    <span class="fl-cell"><b>${d === "S" ? t("towardS") : t("towardN")}</b>
      <span class="flc">${t("firstChip")} <span class="b-time sm">${fmtTime(fl[d][0])}</span></span>
      <span class="flc">${t("lastChip")} <span class="b-time sm">${fmtTime(fl[d][1])}</span></span>
    </span>`).join("");
  renderFacilities(sid);
  rows.sort((a, b) => a.dep - b.dep);
  const seen = new Set();
  const list = rows.filter((r) => {
    const k = `${Math.round(r.dep)}|${r.dir}|${r.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 14);
  $("board-list").innerHTML = list.length
    ? list.map((r) => `
      <li class="board-row ${r.type}">
        <span class="b-time">${fmtTime(r.dep)}</span>
        <span class="b-count">${r.dm < 1 ? t("now") : t("inMin", Math.round(r.dm))}</span>
        <span class="train-chip">${t(r.type)}</span>
        <span class="b-dest">${r.dir === "S" ? "→" : "←"} ${stnName(r.terminal)}</span>
        ${r.isLast ? `<span class="last-chip">${t("lastChip")}</span>` : ""}
      </li>`).join("")
    : `<li class="board-row empty">${t("noneFound")}</li>`;
}

/* ---------- 🛗 車站設施與出口（官網月更資料） ---------- */
const FAC_ICONS = [
  [/詢問|Information/i, "ℹ️"], [/飲用|Drinking/i, "🚰"], [/洗手|廁|Restroom|Toilet/i, "🚻"],
  [/電梯|Elevator/i, "🛗"], [/置物|Locker/i, "🧳"], [/YouBike|自行車|Bike/i, "🚲"],
  [/哺乳|Nursing|Breastfeed/i, "🍼"], [/AED/i, "⛑"], [/充電|Charging/i, "🔌"],
];
function renderFacilities(sid) {
  const card = $("fac-card");
  const fac = facilities?.[sid];
  const L = fac?.[lang === "zh" ? "zh" : "en"] ?? fac?.zh ?? fac?.en;
  if (!L?.info?.length) { card.hidden = true; return; }
  $("fac-title").textContent = `🛗 ${t("facTitle")}`;
  const icon = (k) => FAC_ICONS.find(([re]) => re.test(k))?.[1] ?? "•";
  const rows = L.info
    .filter(([, v]) => !/^(none|無|沒有)[。.]?$/i.test(v.trim()))
    .map(([k, v]) => `<div class="fac-row"><span class="fac-k">${icon(k)} ${k}</span><span class="fac-v">${v.replace(/\n/g, "<br>")}</span></div>`);
  // 出口清單：目前語言沒有就回落另一語言（A1 中文頁無出口表）
  const exits = L.exits?.length ? L.exits : fac.zh?.exits?.length ? fac.zh.exits : fac.en?.exits ?? [];
  if (exits.length) {
    rows.push(`<div class="fac-row"><span class="fac-k">🚪 ${t("exitsL")}</span><span class="fac-v">${exits.map(([n, loc]) => `<b>${n}</b>　${loc}`).join("<br>")}</span></div>`);
  }
  $("fac-body").innerHTML = rows.join("");
  card.hidden = false;
}

/* ---------- 定位最近車站 ---------- */
function haversineKm([lon1, lat1], [lon2, lat2]) {
  const R = 6371, d = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * d) / 2) ** 2 +
    Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin(((lon2 - lon1) * d) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function locateNearest(btn, apply) {
  if (!geo || !navigator.geolocation) return;
  btn.textContent = t("locating");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const here = [pos.coords.longitude, pos.coords.latitude];
      let best = null, bestKm = Infinity;
      for (const s of stations) {
        const km = haversineKm(here, geo[s.id]);
        if (km < bestKm) { bestKm = km; best = s.id; }
      }
      apply(best, Math.round(bestKm * 10) / 10);
    },
    () => { btn.textContent = t("locateFail"); setTimeout(() => (btn.textContent = t("locate")), 2500); },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
  );
}

/* ---------- ✈ 航班（吃 as-jx 每30分更新的 TDX FIDS 看板） ---------- */
// 來源優先序：?fids= 覆寫 → 本站 data/fids.json（每30分排程更新）→ as-jx tdx.json（備援）
const FIDS_SOURCES = [
  new URLSearchParams(location.search).get("fids"),
  "data/fids.json",
  "https://chung223.github.io/as-jx/tdx.json",
].filter(Boolean);
let fidsCache = null, fidsAt = 0;
async function loadFids() {
  if (fidsCache && Date.now() - fidsAt < 5 * 60 * 1000) return fidsCache;
  for (const url of FIDS_SOURCES) {
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) continue;
      const data = await r.json();
      if (!data?.airports?.TPE) continue;
      fidsCache = data;
      fidsAt = Date.now();
      return fidsCache;
    } catch { /* 試下一個來源 */ }
  }
  throw new Error("fids");
}
const termToStation = (term) => (/2/.test(term) ? "A13" : /1/.test(term) ? "A12" : "A13");
// 收藏航班：與 as-jx 共用（同網域 localStorage，鍵 trav-fav-flights）
const favFlights = () => { try { return JSON.parse(localStorage.getItem("trav-fav-flights")) ?? []; } catch { return []; } };
const favFlightsSave = (a) => { try { localStorage.setItem("trav-fav-flights", JSON.stringify(a.slice(0, 12))); } catch { /* 私隱模式 */ } };

// 桃園機場天氣＋METAR（open-meteo / metar.vatsim.net，皆免金鑰）
let wxCache = null, wxAt = 0, metarLoaded = false;
const wxIcon = (code) =>
  code === 0 ? "☀️" : code <= 2 ? "🌤" : code === 3 ? "☁️" : code < 50 ? "🌫" : code < 70 ? "🌦" : code < 80 ? "🌨" : code < 95 ? "🌧" : "⛈";
const WMO_ZH = { 0: "晴", 1: "大致晴朗", 2: "多雲時晴", 3: "陰", 45: "霧", 48: "凍霧", 51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨", 61: "小雨", 63: "降雨", 65: "大雨", 80: "陣雨", 81: "陣雨", 82: "強陣雨", 95: "雷雨", 96: "雷雨", 99: "雷雨" };
const WIND_DIR = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

async function renderWx() {
  const card = $("wx-details");
  try {
    if (!wxCache || Date.now() - wxAt > 30 * 60 * 1000) {
      const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=25.08&longitude=121.233&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&hourly=precipitation_probability&forecast_days=1&timezone=Asia%2FTaipei");
      if (!r.ok) throw new Error();
      wxCache = await r.json();
      wxAt = Date.now();
      metarLoaded = false;
    }
    const c = wxCache.current, d = wxCache.daily;
    const hourIdx = Math.min(new Date(c.time).getHours(), (wxCache.hourly?.precipitation_probability?.length ?? 1) - 1);
    const pop = wxCache.hourly?.precipitation_probability?.[hourIdx];
    $("wx-strip").innerHTML = `✈ TPE ${wxIcon(c.weather_code)} <b>${Math.round(c.temperature_2m)}°</b>` +
      (pop != null ? ` <span>☔ <b>${pop}%</b></span>` : "") +
      ` <span>💨 <b>${Math.round(c.wind_speed_10m)}</b> km/h</span> <span class="wx-more">▾</span>`;
    const dir = WIND_DIR[Math.round((c.wind_direction_10m ?? 0) / 22.5) % 16];
    $("wx-body").innerHTML = `
      <div class="wx-row">
        ${lang === "zh" && WMO_ZH[c.weather_code] ? `<span><b>${WMO_ZH[c.weather_code]}</b></span>` : ""}
        <span>🌡 <b>${c.temperature_2m}°</b>（體感 ${Math.round(c.apparent_temperature)}°）</span>
        <span>💧 <b>${c.relative_humidity_2m}%</b></span>
        <span>💨 <b>${dir} ${Math.round(c.wind_speed_10m)}</b>${c.wind_gusts_10m > c.wind_speed_10m + 10 ? ` G${Math.round(c.wind_gusts_10m)}` : ""} km/h</span>
        <span>↕ <b>${Math.round(d.temperature_2m_min[0])}–${Math.round(d.temperature_2m_max[0])}°</b></span>
        <span>☔ max <b>${d.precipitation_probability_max[0]}%</b></span>
      </div>
      <div class="wx-metar" id="wx-metar"></div>`;
    card.hidden = false;
    if (card.open) loadMetar();
  } catch { card.hidden = true; }
}
$("wx-details").addEventListener("toggle", () => { if ($("wx-details").open) loadMetar(); });

async function loadMetar() {
  if (metarLoaded) return;
  const el = $("wx-metar");
  if (!el) return;
  metarLoaded = true;
  try {
    const raw = (await (await fetch("https://metar.vatsim.net/RCTP")).text()).trim();
    if (!raw.startsWith("RCTP")) throw new Error();
    const wind = raw.match(/ (\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT/);
    const visM = raw.match(/ (\d{4}) /);
    const cavok = raw.includes("CAVOK");
    const qnh = raw.match(/ Q(\d{4})/);
    const temps = raw.match(/ (M?\d{2})\/(M?\d{2}) /);
    const n = (s) => Number(String(s).replace("M", "-"));
    let ceil = Infinity;
    for (const m of raw.matchAll(/(BKN|OVC)(\d{3})/g)) ceil = Math.min(ceil, Number(m[2]) * 100);
    const vis = cavok ? 10000 : visM ? Number(visM[1]) : 9999;
    const cat = vis < 1600 || ceil < 500 ? "LIFR" : vis < 4800 || ceil < 1000 ? "IFR" : vis <= 8000 || ceil <= 3000 ? "MVFR" : "VFR";
    el.innerHTML = `
      <div class="wx-row metar">
        <span class="metar-cat ${cat.toLowerCase()}">${cat}</span>
        ${wind ? `<span>WIND <b>${wind[1]}° ${wind[2]}${wind[3] ? `G${wind[3]}` : ""}kt</b></span>` : ""}
        <span>VIS <b>${cavok ? "CAVOK" : vis >= 9999 ? "10km+" : `${vis}m`}</b></span>
        ${ceil < Infinity ? `<span>CEIL <b>${ceil}ft</b></span>` : ""}
        ${temps ? `<span>T/Td <b>${n(temps[1])}/${n(temps[2])}°</b></span>` : ""}
        ${qnh ? `<span>QNH <b>${qnh[1]}</b></span>` : ""}
      </div>
      <code class="metar-raw">${raw}</code>`;
  } catch { el.innerHTML = ""; metarLoaded = false; }
}

async function renderFlight() {
  renderWx();
  const list = $("flight-list");
  $("fl-dir-dep").textContent = t("flightDep");
  $("fl-dir-arr").textContent = t("flightArr");
  $("fl-dir-dep").classList.toggle("on", state.flightDir === "dep");
  $("fl-dir-arr").classList.toggle("on", state.flightDir === "arr");
  $("fids-note").textContent = t("fidsNote");
  let data;
  try { data = await loadFids(); } catch {
    list.innerHTML = `<li class="board-row empty">${t("fidsFail")}</li>`;
    return;
  }
  const isDep = state.flightDir === "dep";
  const q = ($("flight-search").value ?? "").trim().toUpperCase();
  // 已過時刻的班次不再顯示（出發保留 5 分緩衝；抵達保留 30 分供接機看行李轉盤）
  const nowB = taipeiNow();
  const passed = (r) => {
    const tm = r.at || r.et || r.st;
    if (!tm) return false;
    let d = Number(tm.slice(0, 2)) * 60 + Number(tm.slice(3)) - nowB.min;
    if (d < -720) d += 1440;
    if (d > 720) d -= 1440;
    return d < (isDep ? -5 : -30);
  };
  const favsF = favFlights();
  const rows = (data.airports?.TPE?.[state.flightDir] ?? []).filter((r) =>
    !passed(r) && (!q || r.f.includes(q) || (r.cs ?? []).some((c) => c.includes(q)) || r.o.includes(q))
  ).sort((a, b) => favsF.includes(b.f) - favsF.includes(a.f)) // 收藏置頂（穩定排序保留時間序）
   .slice(0, 30);
  $("fids-note").textContent = `${t("fidsNote")} · ${t("fidsUpdated")} ${data.updated_at ?? ""}`;
  // 明日／後天班次（搜尋時才找；來源為 FIDS 未來 48 小時窗口）
  let futureHtml = "";
  if (q && fidsFuture) {
    const nowS = taipeiNow();
    for (const off of [0, 1, 2]) {
      const date = shiftDate(nowS.date, off);
      const hits = (fidsFuture[state.flightDir] ?? [])
        .filter((r) => r.date === date && (r.f.includes(q) || (r.cs ?? []).some((c) => c.includes(q)) || r.o.includes(q)))
        .sort((a, b) => a.t.localeCompare(b.t))
        .slice(0, 6);
      if (!hits.length) continue;
      const label = off === 0 ? "schedLater" : off === 1 ? "schedTomorrow" : "schedDayAfter";
      futureHtml += `<li class="board-row sched-head">${t(label, date.slice(5).replace("-", "/"))}</li>`;
      futureHtml += hits.map((r) => `
        <li class="flight-row">
          <div class="fl-main">
            <span class="b-time">${r.t}</span>
            <span class="fl-no">${r.f}</span>
            <span class="fl-dest">${isDep ? "→" : "←"} ${r.o}</span>
            <span class="fl-tag">${t("schedTag")}</span>
          </div>
          <div class="fl-sub">
            ${r.term ? `<span class="fl-tag term">${t("terminalL")} ${r.term} · ${t("alightAt", termToStation(r.term))}</span>` : ""}
            ${isDep ? `<span class="fl-tag">${t("counterTba")}</span>` : ""}
            <button class="fl-go" data-sched='${JSON.stringify({ ...r, date }).replace(/'/g, "&#39;")}'>${t("planGo")}</button>
          </div>
        </li>`).join("");
    }
  }
  list.innerHTML = (rows.length
    ? rows.map((r, i) => `
      <li class="flight-row">
        <div class="fl-main">
          <button class="fav-star-fl" data-ffav="${r.f}" title="${t("favFlight")}">${favsF.includes(r.f) ? "★" : "☆"}</button>
          <span class="b-time">${r.at || r.et || r.st}</span>
          <span class="fl-no">${r.f}${(r.cs ?? []).length ? `<span class="fl-cs">+${r.cs.length}</span>` : ""}</span>
          <span class="fl-dest">${isDep ? "→" : "←"} ${r.o}</span>
          ${r.rm ? `<span class="fl-rm">${r.rm}</span>` : ""}
        </div>
        <div class="fl-sub">
          ${r.term ? `<span class="fl-tag term">${t("terminalL")} ${r.term} · ${t("alightAt", termToStation(r.term))}</span>` : ""}
          ${isDep && r.ck ? `<span class="fl-tag ck">${t("counterL")} ${r.ck}</span>` : ""}
          ${!isDep && r.belt ? `<span class="fl-tag ck">${t("beltL")} ${r.belt}</span>` : ""}
          ${isDep && r.gate ? `<span class="fl-tag">${t("gateL")} ${r.gate}</span>` : ""}
          <button class="fl-go alt" data-share="${i}">${t("shareLink")}</button>
          <button class="fl-go" data-fi="${i}">${t("planGo")}</button>
        </div>
      </li>`).join("")
    : futureHtml ? "" : `<li class="board-row empty">${t("noneFound")}</li>`) + futureHtml;

  // 未來日期班次 → 以該日反推規劃（報到櫃台當日才公布）
  list.querySelectorAll("[data-sched]").forEach((btn) => (btn.onclick = () => {
    const r = JSON.parse(btn.dataset.sched);
    const stM = hm2min(r.t);
    const kind = r.kind ?? state.flightDir;
    const target = kind === "arr" ? stM : Math.max(stM - 150, 0);
    state.to = termToStation(r.term);
    state.mode = "arrive";
    state.custom = `${r.date}T${fmtTime(target)}`;
    state.hsrCtx = null;
    state.flightCtx = { kind, f: r.f, o: r.o, st: r.t, et: "", term: r.term, ck: "", gate: "", belt: "", date: r.date, sched: true };
    $("custom-time").value = state.custom;
    refreshOD(); renderFavs(); syncHash();
    setView("plan");
    setMode("arrive");
  }));

  // 收藏航班（與 as-jx 互通）
  list.querySelectorAll("[data-ffav]").forEach((btn) => (btn.onclick = (e) => {
    e.stopPropagation();
    const a = favFlights();
    const i = a.indexOf(btn.dataset.ffav);
    if (i >= 0) a.splice(i, 1); else a.unshift(btn.dataset.ffav);
    favFlightsSave(a);
    renderFlight();
  }));

  // 分享航班深連結（接送機協調用：對方打開直接看到這班）
  list.querySelectorAll("[data-share]").forEach((btn) => (btn.onclick = async () => {
    const r = rows[Number(btn.dataset.share)];
    const url = `${location.origin}${location.pathname}#flight=${r.f}`;
    const text = `✈ ${r.f} ${r.st} ${isDep ? "→" : "←"} ${r.o}${r.term ? ` · T${r.term}` : ""}`;
    let shared = false;
    if (navigator.share) {
      try { await navigator.share({ title: "快轉", text, url }); shared = true; }
      catch (e) { if (e?.name === "AbortError") return; }
    }
    if (!shared) {
      // 桌機或分享面板不可用：退回複製連結
      try { await navigator.clipboard.writeText(url); } catch {
        const ta = document.createElement("textarea");
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.textContent = t("linkCopied");
      setTimeout(() => (btn.textContent = t("shareLink")), 2000);
    }
  }));

  list.querySelectorAll("[data-fi]").forEach((btn) => (btn.onclick = () => {
    const r = rows[Number(btn.dataset.fi)];
    const now = taipeiNow();
    const st = Number(r.st.slice(0, 2)) * 60 + Number(r.st.slice(3));
    // 出發：起飛前 2.5 小時抵達；接機：班機抵達時刻抵達
    const target = isDep ? Math.max(st - 150, now.min + 1) : Math.max(st, now.min + 1);
    const date = st < now.min - 120 ? shiftDate(now.date, 1) : now.date;
    state.to = termToStation(r.term);
    state.mode = "arrive";
    state.custom = `${date}T${fmtTime(target)}`;
    state.hsrCtx = null;
    state.flightCtx = { kind: state.flightDir, f: r.f, o: r.o, st: r.st, et: r.et ?? "", term: r.term, ck: r.ck ?? "", gate: r.gate ?? "", belt: r.belt ?? "", date };
    $("custom-time").value = state.custom;
    refreshOD(); renderFavs(); syncHash();
    setView("plan");
    setMode("arrive");
  }));
}
$("flight-search").addEventListener("input", () => renderFlight());
$("fl-dir-dep").addEventListener("click", () => { state.flightDir = "dep"; renderFlight(); });
$("fl-dir-arr").addEventListener("click", () => { state.flightDir = "arr"; renderFlight(); });

/* ---------- 🚄 高鐵：任意起訖規劃（含餘票／票價／轉機捷），無資料時退回 A18 接駁清單 ---------- */
const thsrName = (sid) => {
  const s = thsrStations?.find((x) => x.id === sid);
  return s ? (lang === "zh" ? s.zh : s.en || s.zh) : sid;
};
const seatCls = (v) => {
  if (!v) return "";
  if (v === "X" || /full|售完/i.test(v)) return "none";
  if (v === "L" || /limit/i.test(v)) return "few";
  if (v === "O" || /avail/i.test(v)) return "ok";
  return "";
};
const seatChip = (v, label) => {
  const cls = seatCls(v);
  if (!cls) return "";
  const txt = cls === "none" ? t("seatNone") : cls === "few" ? t("seatFew") : t("seatOk");
  return `<span class="seat-chip ${cls}">${label} ${txt}</span>`;
};
/** 某站搭某班車「到指定站」的餘票 [標準, 商務]；相容舊版單一狀態格式 */
function seatFor(from, no, to) {
  const ent = thsrSeat?.[from]?.[no];
  if (!ent?.length) return null;
  if (!Array.isArray(ent[0])) return ent; // 舊格式 [std, biz]
  const hit = ent.find((e) => e[0] === to) ?? ent.find((e) => e[0] === "*") ?? ent[ent.length - 1];
  return hit ? [hit[1], hit[2]] : null;
}
/** 逐站餘票明細（新格式才有） */
function seatRoute(from, no) {
  const ent = thsrSeat?.[from]?.[no];
  return Array.isArray(ent?.[0]) && ent[0][0] !== "*" ? ent : null;
}
/** 高鐵某日 O→D 班次（依出發時刻排序，含中途停站數） */
function thsrTrips(dateKey, from, to) {
  const trips = [];
  for (const tr of thsrTT?.[dateKey] ?? []) {
    const iF = tr.stops.findIndex(([sid]) => sid === from);
    const iT = tr.stops.findIndex(([sid]) => sid === to);
    if (iF < 0 || iT < 0 || iF >= iT) continue;
    trips.push({ no: tr.no, dep: tr.stops[iF][1], arr: tr.stops[iT][2], via: iT - iF - 1 });
  }
  return trips.sort((a, b) => a.dep.localeCompare(b.dep));
}

function renderThsrFull() {
  $("thsr-full").hidden = false;
  $("hsr-legacy-dir").hidden = true;
  const selF = $("thsr-from"), selT = $("thsr-to");
  if (!selF.options.length) {
    const opts = thsrStations.map((s) => `<option value="${s.id}">${lang === "zh" ? s.zh : s.en || s.zh}</option>`).join("");
    selF.innerHTML = opts;
    selT.innerHTML = opts;
    selF.value = state.thsrFrom;
    selT.value = state.thsrTo;
  }
  $("thsr-d0").textContent = t("thsrToday");
  $("thsr-d1").textContent = t("thsrTomorrow");
  $("thsr-d0").classList.toggle("on", state.thsrDay === 0);
  $("thsr-d1").classList.toggle("on", state.thsrDay === 1);
  const now = taipeiNow();
  const dateKey = shiftDate(now.date, state.thsrDay);
  const from = state.thsrFrom, to = state.thsrTo;
  const fare = thsrFares?.[`${from}|${to}`];
  const fareChip = $("thsr-fare-chip");
  fareChip.hidden = !fare;
  if (fare) fareChip.textContent = t("fare", fare);
  const list = $("hsr-list");
  if (from === to) { list.innerHTML = `<li class="board-row empty">${t("sameStation")}</li>`; return; }
  if (!thsrTT[dateKey]) { list.innerHTML = `<li class="board-row empty">${t("noneFound")}</li>`; return; }
  const availBtn = $("thsr-avail");
  availBtn.textContent = t("seatOnly");
  availBtn.classList.toggle("on", state.thsrSeatOnly);
  availBtn.hidden = state.thsrDay !== 0 || !thsrSeat;
  const trips = thsrTrips(dateKey, from, to)
    .filter((x) => state.thsrDay > 0 || hm2min(x.dep) >= now.min)
    .filter((x) => !(state.thsrSeatOnly && state.thsrDay === 0) || seatFor(from, x.no, to)?.[0] !== "X")
    .slice(0, 15);
  // 標記：最快抵達（今日）、最速班次、晚發早到提示
  let bestArrIdx = -1, bestRideIdx = -1, bestArr = Infinity, bestRide = Infinity;
  trips.forEach((x, i) => {
    x.depM = hm2min(x.dep);
    x.arrM = hm2min(x.arr);
    x.ride = (x.arrM - x.depM + 1440) % 1440;
    if (state.thsrDay === 0 && x.arrM < bestArr) { bestArr = x.arrM; bestArrIdx = i; }
    if (x.ride < bestRide) { bestRide = x.ride; bestRideIdx = i; }
  });
  for (const x of trips) {
    const dom = trips.find((y) => y.depM > x.depM && y.arrM < x.arrM);
    if (dom) x.laterFaster = { dep: dom.dep, save: x.arrM - dom.arrM };
  }
  list.innerHTML = trips.length
    ? trips.map((x, i) => {
        const seats = state.thsrDay === 0 ? seatFor(from, x.no, to) : null;
        const route = state.thsrDay === 0 ? seatRoute(from, x.no) : null;
        return `
        <li class="flight-row ${route ? "has-route" : ""}">
          <div class="fl-main">
            ${i === bestArrIdx ? `<span class="jc-badge sm">${t("fastestArr")}</span>` : ""}
            <span class="b-time">${x.dep}</span><span class="jc-arrow">▶</span><span class="b-time arr-t">${x.arr}</span>
            <span class="fl-dest">${t("trainNoL", x.no)} · ${t("rideN", x.ride)}</span>
            ${to === TY ? `<button class="fl-go" data-cmrt="${x.arr}" data-cdate="${dateKey}">${t("connectMrt")}</button>` : ""}
          </div>
          <div class="fl-sub">
            ${i === bestRideIdx ? `<span class="fl-tag fast">${t("fastestRide", x.ride)}</span>` : ""}
            <span class="fl-tag">${x.via === 0 ? t("thsrNonstop") : t("stopsVia", x.via)}</span>
            ${state.thsrDay === 0 ? seatChip(seats?.[0], t("seatStd")) + seatChip(seats?.[1], t("seatBiz")) : `<span class="fl-tag">${t("schedTag")}</span>`}
            ${x.laterFaster ? `<span class="later-hint">${t("laterFaster", x.laterFaster.dep, x.laterFaster.save)}</span>` : ""}
            ${route ? `<span class="sr-toggle">${t("seatRouteHint")} ▾</span>` : ""}
          </div>
          ${route ? `<div class="seat-route" hidden>${route.map(([sid2, st2, bz2]) =>
            `<span class="sr-stop"><b>${thsrName(sid2)}</b>${seatChip(st2, t("seatStd"))}${seatChip(bz2, t("seatBiz"))}</span>`).join("")}</div>` : ""}
        </li>`;
      }).join("")
    : `<li class="board-row empty">${t("noneFound")}</li>`;
  // 點班次展開各站餘票
  list.querySelectorAll(".has-route").forEach((row) => row.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const d = row.querySelector(".seat-route");
    d.hidden = !d.hidden;
    const tg = row.querySelector(".sr-toggle");
    if (tg) tg.textContent = `${t("seatRouteHint")} ${d.hidden ? "▾" : "▴"}`;
  }));
  const someNoSeat = state.thsrDay === 0 && thsrSeat && trips.some((x) => !seatFor(from, x.no, to));
  $("hsr-note").textContent = `${t("thsrFullNote")}${someNoSeat ? ` · ${t("seatCoverage")}` : ""} · ${t("fidsUpdated")} ${thsrLiveFile?.updated ?? thsrTTFile?.updated ?? ""}`;
  // 抵達桃園 → 一鍵接機捷（抵達 +10 分從 A18 出發）
  list.querySelectorAll("[data-cmrt]").forEach((btn) => (btn.onclick = () => {
    const dep = Math.min(hm2min(btn.dataset.cmrt) + 10, 1439);
    state.from = "A18";
    if (state.to === "A18") state.to = "A13";
    state.mode = "depart";
    state.custom = `${btn.dataset.cdate}T${fmtTime(dep)}`;
    state.flightCtx = null;
    state.hsrCtx = null;
    $("custom-time").value = state.custom;
    refreshOD(); renderFavs(); syncHash();
    setView("plan");
    setMode("depart");
  }));
}

function renderHsr() {
  if (thsrTT && thsrStations) { renderThsrFull(); return; }
  $("thsr-full")?.setAttribute("hidden", "");
  $("hsr-legacy-dir").hidden = false;
  $("hsr-dir-n").textContent = t("hsrNorth");
  $("hsr-dir-s").textContent = t("hsrSouth");
  $("hsr-dir-n").classList.toggle("on", state.hsrDir === 1);
  $("hsr-dir-s").classList.toggle("on", state.hsrDir === 0);
  $("hsr-note").textContent = `${t("hsrNote")} · ${t("version")} ${hsrFile?.updated ?? ""}`;
  const list = $("hsr-list");
  if (!hsr) { list.innerHTML = `<li class="board-row empty">${t("noneFound")}</li>`; return; }
  const now = taipeiNow();
  const dow = (dowOf(now.date) + 6) % 7; // 0=Mon
  const rows = hsr
    .filter((tr) => tr.dir === state.hsrDir && tr.days[dow])
    .map((tr) => ({ ...tr, m: hm2min(tr.dep) }))
    .filter((tr) => tr.m >= now.min)
    .sort((a, b) => a.m - b.m)
    .slice(0, 25);
  list.innerHTML = rows.length
    ? rows.map((tr, i) => `
      <li class="flight-row">
        <div class="fl-main">
          <span class="b-time">${tr.dep}</span>
          <span class="fl-no">🚄 ${t("hsrDest", tr.to?.[lang] ?? tr.to?.zh ?? "")}</span>
          <span class="fl-dest">${tr.m - now.min < 90 ? t("inMin", tr.m - now.min) : ""}</span>
          <button class="fl-go" data-hi="${i}" style="margin-left:auto">${t("planGo")}</button>
        </div>
      </li>`).join("")
    : `<li class="board-row empty">${t("noneFound")}</li>`;
  list.querySelectorAll("[data-hi]").forEach((btn) => (btn.onclick = () => {
    const tr = rows[Number(btn.dataset.hi)];
    const now2 = taipeiNow();
    const target = Math.max(tr.m - 10, now2.min + 1);
    state.to = "A18";
    state.mode = "arrive";
    state.custom = `${now2.date}T${fmtTime(target)}`;
    state.flightCtx = null;
    state.hsrCtx = { dep: tr.dep, to: tr.to, dir: tr.dir };
    $("custom-time").value = state.custom;
    refreshOD(); renderFavs(); syncHash();
    setView("plan");
    setMode("arrive");
  }));
}
$("hsr-dir-n").addEventListener("click", () => { state.hsrDir = 1; renderHsr(); });
$("hsr-dir-s").addEventListener("click", () => { state.hsrDir = 0; renderHsr(); });
$("thsr-from").addEventListener("change", (e) => { state.thsrFrom = e.target.value; localStorage.setItem("trav-hsr-from", state.thsrFrom); renderHsr(); });
$("thsr-to").addEventListener("change", (e) => { state.thsrTo = e.target.value; renderHsr(); });
$("thsr-swap").addEventListener("click", () => {
  [state.thsrFrom, state.thsrTo] = [state.thsrTo, state.thsrFrom];
  $("thsr-from").value = state.thsrFrom;
  $("thsr-to").value = state.thsrTo;
  renderHsr();
});
$("thsr-d0").addEventListener("click", () => { state.thsrDay = 0; renderHsr(); });
$("thsr-d1").addEventListener("click", () => { state.thsrDay = 1; renderHsr(); });
$("thsr-avail").addEventListener("click", () => { state.thsrSeatOnly = !state.thsrSeatOnly; renderHsr(); });
$("thsr-locate").addEventListener("click", () => {
  if (!thsrStations || !navigator.geolocation) return;
  const btn = $("thsr-locate");
  btn.textContent = "…";
  navigator.geolocation.getCurrentPosition((pos) => {
    let best = null, bestKm = Infinity;
    for (const s of thsrStations) {
      if (s.lat == null) continue;
      const km = haversineKm([pos.coords.longitude, pos.coords.latitude], [s.lon, s.lat]);
      if (km < bestKm) { bestKm = km; best = s.id; }
    }
    btn.textContent = "📍";
    if (best) {
      state.thsrFrom = best;
      localStorage.setItem("trav-hsr-from", best);
      $("thsr-from").value = best;
      renderHsr();
    }
  }, () => { btn.textContent = "📍"; }, { timeout: 8000, maximumAge: 300000 });
});

/* ---------- 選站面板 ---------- */
let picking = null;
function openSheet(which) {
  picking = which;
  $("sheet-title").textContent = t(which === "from" ? "pickOrigin" : which === "to" ? "pickDest" : "pickBoard");
  const cur = which === "board" ? state.boardStation : state[which];
  const locateBtn = geo && navigator.geolocation
    ? `<li class="locate-li"><button class="pick-btn locate-btn" id="btn-locate">${t("locate")}</button></li>`
    : "";
  const mrtRows = stations.map((s) => `
      <li><button class="pick-btn ${s.express ? "express" : "local-only"} ${cur === s.id ? "picked" : ""}" data-id="${s.id}">
        <span class="code">${s.id}</span>
        <span><span class="pick-name">${stnName(s.id)}</span><span class="pick-en">${lang === "zh" ? stationById.get(s.id).nameEn : stationById.get(s.id).name}</span></span>
        ${s.express ? `<span class="pick-tag">${t("expressTag")}</span>` : ""}
      </button></li>`).join("");
  // 北捷分線清單（看板選站也開放：即時到站／班距推估）
  let trtcHtml = "";
  if (trtc) {
    trtcHtml = `<li class="sheet-sec">🚇 ${t("trtcSection")}</li>` +
      Object.entries(trtc.lines ?? {}).filter(([, l]) => l.stations?.length).map(([lid, l]) =>
        `<li class="sheet-line"><span class="line-chip" style="--lc:${TRTC_COLORS[lid] ?? "#888"}">${lid}</span></li>` +
        l.stations.map((sid) => `
        <li class="trtc-li"><button class="pick-btn trtc ${cur === sid ? "picked" : ""}" data-id="${sid}">
          <span class="code trtc-code" style="--lc:${TRTC_COLORS[trtcLineOf(sid)] ?? "#888"}">${sid}</span>
          <span><span class="pick-name">${trtcStnName(sid)}</span><span class="pick-en">${lang === "zh" ? (trtc.stations[sid]?.en ?? "") : trtc.stations[sid]?.zh ?? ""}</span></span>
        </button></li>`).join("")
      ).join("");
  }
  $("station-list").innerHTML =
    `<li class="search-li"><input id="stn-search" class="dt-input stn-search" type="search" placeholder="${t("searchStation")}"></li>` +
    locateBtn +
    (trtcHtml ? `<li class="sheet-sec">✈ ${t("mrtSection")}</li>` : "") +
    mrtRows + trtcHtml;
  const si = $("stn-search");
  si.addEventListener("input", () => {
    const q = si.value.trim().toLowerCase();
    $("station-list").querySelectorAll("li").forEach((li) => {
      if (li.classList.contains("search-li")) return;
      if (!q) { li.hidden = false; return; }
      if (!li.querySelector("[data-id]")) { li.hidden = true; return; }
      li.hidden = !li.textContent.toLowerCase().includes(q);
    });
  });
  $("station-sheet").hidden = false;
  $("sheet-backdrop").hidden = false;
  const lb = $("btn-locate");
  if (lb) lb.onclick = () => locateNearest(lb, (id, km) => {
    lb.textContent = `📍 ${id} ${stnName(id)}・${t("kmAway", km)}`;
    setTimeout(() => {
      if (picking === "board") { state.boardStation = id; rememberBoardStn(id); }
      else if (picking) state[picking] = id;
      closeSheet();
      refreshOD(); renderFavs(); syncHash();
      state.view === "board" ? renderBoard() : runQuery();
    }, 450);
  });
  $("station-list").querySelector(".picked")?.scrollIntoView({ block: "center" });
}
function closeSheet() { $("station-sheet").hidden = true; $("sheet-backdrop").hidden = true; picking = null; }
$("station-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-id]");
  if (!btn || !picking) return;
  if (picking === "board") { state.boardStation = btn.dataset.id; rememberBoardStn(btn.dataset.id); }
  else {
    state[picking] = btn.dataset.id;
    // 目的地由航班／高鐵情境決定，改了才清除；改出發站保留（例如改成 A18 接高鐵）
    if (picking === "to") { state.flightCtx = null; state.hsrCtx = null; }
  }
  closeSheet();
  refreshOD(); renderFavs(); syncHash();
  state.view === "board" ? renderBoard() : runQuery();
});
$("sheet-backdrop").addEventListener("click", closeSheet);
addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());

/* ---------- 控制列 ---------- */
function refreshOD() {
  for (const w of ["from", "to"]) {
    $(`${w}-code`).textContent = state[w];
    $(`${w}-name`).textContent = stnName(state[w]);
  }
}
$("btn-from").addEventListener("click", () => openSheet("from"));
$("btn-to").addEventListener("click", () => openSheet("to"));
$("btn-board-station").addEventListener("click", () => openSheet("board"));
$("btn-swap").addEventListener("click", () => {
  [state.from, state.to] = [state.to, state.from];
  state.flightCtx = null;
  state.hsrCtx = null;
  refreshOD(); renderFavs(); syncHash(); runQuery();
});

function setMode(mode) {
  state.mode = mode;
  for (const m of ["now", "depart", "arrive"]) {
    $(`mode-${m}`).classList.toggle("on", mode === m);
    $(`mode-${m}`).setAttribute("aria-selected", String(mode === m));
  }
  const dt = $("custom-time");
  dt.hidden = mode === "now";
  if (mode !== "now" && !dt.value) {
    const now = taipeiNow();
    dt.value = state.custom ?? `${now.date}T${fmtTime(now.min)}`;
  }
  if (mode !== "now") state.custom = dt.value;
  syncHash(); runQuery();
}
$("mode-now").addEventListener("click", () => setMode("now"));
$("mode-depart").addEventListener("click", () => setMode("depart"));
$("mode-arrive").addEventListener("click", () => setMode("arrive"));
$("custom-time").addEventListener("change", (e) => { state.custom = e.target.value; syncHash(); runQuery(); });

function setView(view) {
  state.view = view;
  for (const v of ["plan", "board", "flight", "hsr"]) {
    $(`tab-${v}`).classList.toggle("on", view === v);
    $(`${v}-wrap`).hidden = view !== v;
  }
  if (view === "board") renderBoard();
  else if (view === "flight") renderFlight();
  else if (view === "hsr") renderHsr();
  else runQuery();
}
$("tab-plan").addEventListener("click", () => setView("plan"));
$("tab-board").addEventListener("click", () => setView("board"));
$("tab-flight").addEventListener("click", () => setView("flight"));
$("tab-hsr").addEventListener("click", () => setView("hsr"));

/* ---------- 語言切換 ---------- */
function applyStatic() {
  $("od-label-from").textContent = t("from");
  $("od-label-to").textContent = t("to");
  $("mode-now").textContent = t("modeNow");
  $("mode-depart").textContent = t("modeDepart");
  $("mode-arrive").textContent = t("modeArrive");
  $("tab-plan").textContent = t("tabPlan");
  $("tab-board").textContent = t("tabBoard");
  $("tab-flight").textContent = t("tabFlight");
  $("tab-hsr").textContent = t("tabHsr");
  $("flight-search").placeholder = t("flightSearchPh");
  $("fav-title").textContent = t("favTitle");
  $("board-title").textContent = t("boardTitle");
  $("board-swap-hint").textContent = `${t("changeStn")} ▾`;
  $("map-hint-text").innerHTML = `<span class="dot-demo express"></span>${t("legendExpress")}　<span class="dot-demo"></span>${t("legendLocal")}　<span class="dot-demo live"></span>${t("liveNote")}`;
  $("data-note").innerHTML = `${timetable.dataStatus === "estimate" ? t("dataEstimate") : t("dataOfficial")} · ${t("version")} <code>${timetable.version}</code>`;
  $("lang-sel").value = lang;
}
$("lang-sel").addEventListener("change", (e) => {
  lang = e.target.value;
  localStorage.setItem("tymf-lang", lang);
  t = makeT(lang);
  document.documentElement.lang = lang === "zh" ? "zh-Hant-TW" : lang;
  applyStatic(); refreshOD(); renderFavs(); renderAlerts();
  state.view === "board" ? renderBoard() : runQuery();
});

/* ---------- 深淺模式（◐自動 → ●深 → ○淺） ---------- */
const THEME_ICON = { auto: "◐", dark: "●", light: "○" };
// trav-theme 為與姊妹站（as-jx）互通的共用鍵：dark/light，缺值＝自動
let theme = localStorage.getItem("trav-theme") ?? localStorage.getItem("tymf-theme") ?? "auto";
if (!THEME_ICON[theme]) theme = "auto";
function applyTheme() {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $("theme-btn").textContent = THEME_ICON[theme];
  const dark = theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#120f0a" : "#ece4d2");
}
$("theme-btn").addEventListener("click", () => {
  theme = theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto";
  localStorage.setItem("tymf-theme", theme);
  try { theme === "auto" ? localStorage.removeItem("trav-theme") : localStorage.setItem("trav-theme", theme); } catch { /* 私隱模式 */ }
  applyTheme();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyTheme);
applyTheme();

/* ---------- 時鐘與自動更新 ---------- */
let lastMin = -1;
function tick() {
  const now = taipeiNow();
  $("clock").innerHTML = `${fmtTime(now.min).slice(0, 2)}<span class="tick">:</span>${fmtTime(now.min).slice(3)}`;
  if (now.min !== lastMin) {
    lastMin = now.min;
    if (state.view === "board") renderBoard();
    else if (state.view === "hsr") renderHsr();
    else if (state.view === "plan" && state.mode === "now") runQuery();
  }
  // 每 5 秒更新路線圖上的列車位置模擬
  if (state.view === "plan" && mapCtx) {
    const layer = $("train-dots");
    if (layer) layer.innerHTML = trainDotsSvg(mapCtx);
  }
  // 北捷即時看板每 20 秒刷新
  if (state.view === "board" && isTrtc(state.boardStation) && liveApi && Date.now() - trtcBoardAt > 20000) {
    renderTrtcBoard(state.boardStation);
  }
}
setInterval(tick, 5000);

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* ---------- 啟動 ---------- */
document.documentElement.lang = lang === "zh" ? "zh-Hant-TW" : lang;
applyStatic();
renderAlerts();
refreshOD();
renderFavs();
if (state.mode !== "now") { $("custom-time").value = state.custom; setMode(state.mode); }
if (pendingFlightSearch) { $("flight-search").value = pendingFlightSearch; setView("flight"); }
else if (pendingView) setView(pendingView);
tick();

// 定位預選最近車站：權限未拒絕就每次開站嘗試（已授權→靜默、未決定→跳詢問）。
// 僅「帶時間的分享連結」與「航班深連結」尊重連結不覆蓋；使用者手動改過站也不覆蓋。
if (!pendingFlightSearch && !(hashHadFrom && state.custom) && geo && navigator.geolocation) {
  const bootFrom = state.from;
  const applyNearest = (pos) => {
    if (state.from !== bootFrom) return; // 使用者已自行選站
    const here = [pos.coords.longitude, pos.coords.latitude];
    let best = null, bestKm = Infinity;
    for (const s of stations) {
      const km = haversineKm(here, geo[s.id]);
      if (km < bestKm) { bestKm = km; best = s.id; }
    }
    if (best && best !== state.from && best !== state.to) {
      state.from = best;
      refreshOD(); renderFavs(); syncHash();
      if (state.view === "plan") runQuery();
    }
  };
  const locate = () => navigator.geolocation.getCurrentPosition(applyNearest, () => {}, { timeout: 8000, maximumAge: 300000 });
  if (navigator.permissions?.query) {
    navigator.permissions.query({ name: "geolocation" })
      .then((p) => { if (p.state !== "denied") locate(); })
      .catch(locate);
  } else {
    locate();
  }
}
