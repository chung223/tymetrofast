/* 機捷快轉 · 前端主程式 */
import { buildIndex, planDirect, planOptions, planJourney, planArriveBy, fmtTime } from "./planner.js";
import { LANGS, LANG_LABEL, makeT } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const loadJson = (u) => fetch(u).then((r) => (r.ok ? r.json() : Promise.reject(u)));
const tryJson = (u) => loadJson(u).catch(() => null);

const [network, timetable, holidaysFile, extraNames, geo, faresFile, hsrFile] = await Promise.all([
  loadJson("data/network.json"),
  loadJson("data/timetable.json"),
  loadJson("data/holidays.json"),
  tryJson("data/station-names.json"),
  tryJson("data/geo.json"),
  tryJson("data/fares.json"),
  tryJson("data/hsr-a18.json"),
]);
const holidays = new Set(holidaysFile.holidays);
const stations = network.stations;
const stationById = new Map(stations.map((s) => [s.id, s]));
const fares = faresFile?.pairs ?? null;
const hsr = hsrFile?.trains?.length ? hsrFile.trains : null;
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
const stnName = (id) => (lang === "zh" ? stationById.get(id).name : extraNames?.[id]?.[lang] || stationById.get(id).nameEn);
const stnLabel = (id) => `${id} ${stnName(id)}`;

/* ---------- 台灣時間 ---------- */
function taipeiNow() {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" });
  return { date: s.slice(0, 10), min: Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)) };
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
const state = { view: "plan", from: "A1", to: "A16", boardStation: "A1", mode: "now", custom: null, flightCtx: null, flightDir: "dep" };
let hashHadFrom = false, pendingFlightSearch = null;
(function initFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (stationById.has(p.get("from"))) { state.from = p.get("from"); hashHadFrom = true; }
  if (stationById.has(p.get("to"))) state.to = p.get("to");
  const m = p.get("m");
  if (m === "arrive" || m === "depart") state.mode = m;
  if (p.get("t") && p.get("t") !== "now") state.custom = p.get("t");
  if (state.mode !== "now" && !state.custom) state.mode = "now";
  if (p.get("flight")) pendingFlightSearch = p.get("flight").toUpperCase();
})();
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

function journeyCard(j, { badge, badgeAlt, saveMin, nextDay, fare } = {}) {
  const total = Math.round(j.arr - j.dep);
  return `
  <article class="panel journey-card ${badgeAlt ? "" : "best"}">
    <div class="jc-head">
      <span class="jc-badge ${badgeAlt ? "alt" : ""}">${badge}</span>
      ${badgeAlt ? "" : `<button class="cal-btn" id="btn-cal" title="${t("addCal")}">⏰</button>`}
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
        .map((x) => `<span class="hsr-train"><b>${x.dep}</b> ${t("hsrTo")}${x.to?.[lang] ?? x.to?.zh ?? ""}</span>`).join("")}</div>`
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
    html += `
    <aside class="panel flight-banner">
      <span class="fl-no">✈ ${fc.f}</span><span class="b-time">${fc.st}</span><span class="fl-dest">${isDep ? "→" : "←"} ${fc.o}</span>
      <span class="fl-tag term">${t("terminalL")} ${fc.term} · ${t("alightAt", stnLabel(state.to))}</span>
      ${isDep && fc.ck ? `<span class="fl-tag ck">${t("counterL")} ${fc.ck}</span>` : ""}
      ${!isDep && fc.belt ? `<span class="fl-tag ck">${t("beltL")} ${fc.belt}</span>` : ""}
      ${isDep && fc.gate ? `<span class="fl-tag">${t("gateL")} ${fc.gate}</span>` : ""}
      ${bagHtml}
      <span class="fl-note">${t(isDep ? "flightPlanNote" : "pickupNote")}</span>
    </aside>`;
  }
  if (nextDay) html += `<div class="panel empty-card">${t("noServiceToday")}</div>`;
  if (cantMake) html += `<div class="panel empty-card">${t("cantMake")}</div>`;

  if (arriveMode) {
    html += journeyCard(best, { badge: t("latestDep"), fare });
    for (const o of options.slice(1)) html += journeyCard(o, { badge: t("nextCard"), badgeAlt: true });
  } else {
    const directIsBest = direct && direct.dep === best.dep && direct.arr === best.arr && best.transfers === 0;
    const saveMin = direct ? Math.round(abs(direct) - abs(best)) : 0;
    html += journeyCard(best, { badge: t("fastest"), saveMin, nextDay, fare });
    if (direct && !directIsBest && best.transfers > 0) html += journeyCard(direct, { badge: t("directCard"), badgeAlt: true, nextDay });
    const rest = options.slice(1).filter((o) => !(direct && o.dep === direct.dep && o.arr === direct.arr && o.transfers === 0));
    if (rest.length) {
      html += `<h3 class="options-title">${t("nextCard")}</h3>`;
      for (const o of rest) html += journeyCard(o, { badge: t("nextCard"), badgeAlt: true, nextDay });
    }
  }

  // A18 高鐵接駁
  const a18 = best.legs.find((l) => l.to === "A18") ?? (state.to === "A18" ? best.legs[best.legs.length - 1] : null);
  if (a18 && ctx) html += hsrPanel(a18.arr, ctx);
  // 機場預辦登機提示
  if (state.to === "A12" || state.to === "A13") html += `<aside class="panel tip-card">${t("checkinTip")}</aside>`;

  box.innerHTML = html;
  renderLineMap(best);
  const calBtn = $("btn-cal");
  if (calBtn) calBtn.onclick = () => addReminder(best, ctx, calBtn);
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

/* ---------- 路線圖（示意 / 地理） ---------- */
let mapView = localStorage.getItem("tymf-map") ?? "schematic";
function renderLineMap(journey) {
  lastJourney = journey;
  if (mapView === "geo" && geo) renderGeoMap(journey);
  else renderSchematic(journey);
  $("map-toggle").textContent = mapView === "geo" ? t("mapSchematic") : t("mapGeo");
}
let lastJourney = null;

function renderSchematic(journey) {
  const svg = $("line-map");
  const n = stations.length;
  const W = Math.max(690, svg.clientWidth || 690);
  const PAD = 26, Y = 40;
  const x = (i) => PAD + (i * (W - PAD * 2)) / (n - 1);
  const pos = new Map(stations.map((s, i) => [s.id, i]));
  let g = `<line x1="${PAD}" y1="${Y}" x2="${W - PAD}" y2="${Y}" stroke="var(--rail)" stroke-width="5" stroke-linecap="round"/>`;

  if (journey) {
    journey.legs.forEach((leg, li) => {
      const x1 = x(pos.get(leg.from)), x2 = x(pos.get(leg.to));
      const y = Y + (li > 0 && leg.dir !== journey.legs[0].dir ? 9 : 0);
      const color = leg.type === "express" ? "var(--purple)" : "var(--blue)";
      g += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}" stroke-width="7" stroke-linecap="round" opacity="0.95"/>`;
      g += `<line class="flow" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`;
      const mid = (x1 + x2) / 2;
      g += `<polygon points="${mid - 5},${y - 4} ${mid - 5},${y + 4} ${mid + 4},${y}" fill="var(--ink)" transform="${x2 < x1 ? `rotate(180 ${mid} ${y})` : ""}"/>`;
    });
  }
  stations.forEach((s, i) => {
    const cx = x(i);
    const inJourney = journey && journey.legs.some((l) => l.from === s.id || l.to === s.id);
    g += `<circle cx="${cx}" cy="${Y}" r="${s.express ? 6 : 4.5}" fill="${inJourney ? "var(--amber)" : "#fff"}" stroke="${s.express ? "var(--purple)" : "var(--blue)"}" stroke-width="2.5"/>`;
    g += `<text x="${cx}" y="${Y + 22}" transform="rotate(-52 ${cx} ${Y + 22})" text-anchor="end" font-size="10" font-family="Chakra Petch, sans-serif" font-weight="600" fill="${inJourney ? "var(--amber)" : "var(--text-dim)"}">${s.id}</text>`;
  });
  if (journey) {
    const marks = new Map();
    marks.set(journey.legs[0].from, "起");
    journey.legs.forEach((l, i) => i < journey.legs.length - 1 && marks.set(l.to, "轉"));
    marks.set(journey.legs[journey.legs.length - 1].to, "訖");
    const sorted = [...marks].sort((a, b) => pos.get(a[0]) - pos.get(b[0]));
    let prevX = -Infinity, prevTier = 1;
    for (const [id, kind] of sorted) {
      const cx = x(pos.get(id));
      const tier = cx - prevX < 88 && prevTier === 1 ? 2 : 1;
      prevX = cx; prevTier = tier;
      g += `<text x="${cx}" y="${tier === 1 ? Y - 12 : Y - 26}" text-anchor="middle" font-size="11" font-weight="700" font-family="Noto Sans TC, sans-serif" fill="${kind === "轉" ? "var(--amber)" : "var(--green)"}">${stnName(id)}</text>`;
    }
  }
  svg.setAttribute("viewBox", `0 0 ${W} 104`);
  svg.style.height = "104px";
  svg.innerHTML = g;
  if (journey) {
    const xs = journey.legs.flatMap((l) => [x(pos.get(l.from)), x(pos.get(l.to))]);
    const scroller = svg.closest(".line-map-scroll");
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    scroller.scrollTo({ left: (mid / W) * svg.scrollWidth - scroller.clientWidth / 2, behavior: "smooth" });
  }
}

function renderGeoMap(journey) {
  const svg = $("line-map");
  const W = 690, H = 300, PAD = 30;
  const lons = stations.map((s) => geo[s.id][0]), lats = stations.map((s) => geo[s.id][1]);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const kx = (W - PAD * 2) / (maxLon - minLon);
  const ky = (H - PAD * 2) / (maxLat - minLat);
  const k = Math.min(kx, ky * 1.0);
  const px = (id) => PAD + (geo[id][0] - minLon) * kx;
  const py = (id) => H - PAD - (geo[id][1] - minLat) * ky;
  const pts = stations.map((s) => `${px(s.id)},${py(s.id)}`).join(" ");
  let g = `<polyline points="${pts}" fill="none" stroke="var(--rail)" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
  if (journey) {
    const pos = new Map(stations.map((s, i) => [s.id, i]));
    for (const leg of journey.legs) {
      const i1 = pos.get(leg.from), i2 = pos.get(leg.to);
      const [a, b] = i1 < i2 ? [i1, i2] : [i2, i1];
      const sub = stations.slice(a, b + 1).map((s) => `${px(s.id)},${py(s.id)}`).join(" ");
      const color = leg.type === "express" ? "var(--purple)" : "var(--blue)";
      g += `<polyline points="${sub}" fill="none" stroke="${color}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>`;
      g += `<polyline class="flow" points="${sub}" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  }
  const KEY = new Set(["A1", "A8", "A12", "A13", "A18", "A21", "A22", state.from, state.to]);
  for (const s of stations) {
    const inJourney = journey && journey.legs.some((l) => l.from === s.id || l.to === s.id);
    g += `<circle cx="${px(s.id)}" cy="${py(s.id)}" r="${s.express ? 5.5 : 4}" fill="${inJourney ? "var(--amber)" : "#fff"}" stroke="${s.express ? "var(--purple)" : "var(--blue)"}" stroke-width="2.5"/>`;
    if (KEY.has(s.id)) {
      const cx = px(s.id);
      const anchor = cx > W - 110 ? "end" : cx < 110 ? "start" : geo[s.id][0] > (minLon + maxLon) / 2 ? "start" : "end";
      g += `<text x="${cx + (anchor === "start" ? 9 : -9)}" y="${py(s.id) + 4}" text-anchor="${anchor}" font-size="11" font-weight="700" font-family="Noto Sans TC, sans-serif" fill="${inJourney ? "var(--amber)" : "var(--text-dim)"}">${stnName(s.id)}</text>`;
    }
  }
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.style.height = "300px";
  svg.innerHTML = g;
}
$("map-toggle").addEventListener("click", () => {
  mapView = mapView === "geo" ? "schematic" : "geo";
  localStorage.setItem("tymf-map", mapView);
  renderLineMap(lastJourney);
});

/* ---------- 車站看板 ---------- */
function renderBoard() {
  const now = taipeiNow();
  const sid = state.boardStation;
  $("board-code").textContent = sid;
  $("board-name").textContent = stnName(sid);
  const rows = [];
  const push = (dayType, offset) => {
    const idx = getIndex(dayType);
    for (const c of idx.connections) {
      if (c.from !== sid) continue;
      const dep = c.dep + offset;
      const dm = dep - now.min;
      if (dm < -0.5 || dm > 120) continue;
      const train = idx.trainById.get(c.trip);
      rows.push({ dep, dm, type: c.type, dir: c.dir, terminal: train.stops[train.stops.length - 1][0] });
    }
  };
  push(dayTypeOf(now.date), 0);
  if (now.min < 180) push(dayTypeOf(shiftDate(now.date, -1)), -1440);
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
      </li>`).join("")
    : `<li class="board-row empty">${t("noneFound")}</li>`;
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
const FIDS_URL = new URLSearchParams(location.search).get("fids") ?? "https://chung223.github.io/as-jx/tdx.json";
let fidsCache = null, fidsAt = 0;
async function loadFids() {
  if (fidsCache && Date.now() - fidsAt < 5 * 60 * 1000) return fidsCache;
  const r = await fetch(FIDS_URL, { cache: "no-cache" });
  if (!r.ok) throw new Error("fids");
  fidsCache = await r.json();
  fidsAt = Date.now();
  return fidsCache;
}
const termToStation = (term) => (/2/.test(term) ? "A13" : /1/.test(term) ? "A12" : "A13");

// 桃園機場天氣（open-meteo，免金鑰）
let wxCache = null, wxAt = 0;
async function renderWx() {
  const el = $("wx-strip");
  try {
    if (!wxCache || Date.now() - wxAt > 30 * 60 * 1000) {
      const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=25.08&longitude=121.233&current=temperature_2m,weather_code,wind_speed_10m&hourly=precipitation_probability&forecast_days=1&timezone=Asia%2FTaipei");
      if (!r.ok) throw new Error();
      wxCache = await r.json();
      wxAt = Date.now();
    }
    const c = wxCache.current;
    const code = c.weather_code;
    const icon = code === 0 ? "☀️" : code <= 2 ? "🌤" : code === 3 ? "☁️" : code < 50 ? "🌫" : code < 70 ? "🌦" : code < 80 ? "🌨" : code < 95 ? "🌧" : "⛈";
    const hourIdx = Math.min(new Date(wxCache.current.time).getHours(), (wxCache.hourly?.precipitation_probability?.length ?? 1) - 1);
    const pop = wxCache.hourly?.precipitation_probability?.[hourIdx];
    el.innerHTML = `✈ TPE ${icon} <b>${Math.round(c.temperature_2m)}°</b>` +
      (pop != null ? ` <span>☔ <b>${pop}%</b></span>` : "") +
      ` <span>💨 <b>${Math.round(c.wind_speed_10m)}</b> km/h</span>`;
    el.hidden = false;
  } catch { el.hidden = true; }
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
  const rows = (data.airports?.TPE?.[state.flightDir] ?? []).filter((r) =>
    !q || r.f.includes(q) || (r.cs ?? []).some((c) => c.includes(q)) || r.o.includes(q)
  ).slice(0, 30);
  $("fids-note").textContent = `${t("fidsNote")} · ${t("fidsUpdated")} ${data.updated_at ?? ""}`;
  list.innerHTML = rows.length
    ? rows.map((r, i) => `
      <li class="flight-row">
        <div class="fl-main">
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
          <button class="fl-go" data-fi="${i}">${t("planGo")}</button>
        </div>
      </li>`).join("")
    : `<li class="board-row empty">${t("noneFound")}</li>`;

  list.querySelectorAll(".fl-go").forEach((btn) => (btn.onclick = () => {
    const r = rows[Number(btn.dataset.fi)];
    const now = taipeiNow();
    const st = Number(r.st.slice(0, 2)) * 60 + Number(r.st.slice(3));
    // 出發：起飛前 2.5 小時抵達；接機：班機抵達時刻抵達
    const target = isDep ? Math.max(st - 150, now.min + 1) : Math.max(st, now.min + 1);
    const date = st < now.min - 120 ? shiftDate(now.date, 1) : now.date;
    state.to = termToStation(r.term);
    state.mode = "arrive";
    state.custom = `${date}T${fmtTime(target)}`;
    state.flightCtx = { kind: state.flightDir, f: r.f, o: r.o, st: r.st, term: r.term, ck: r.ck ?? "", gate: r.gate ?? "", belt: r.belt ?? "", date };
    $("custom-time").value = state.custom;
    refreshOD(); renderFavs(); syncHash();
    setView("plan");
    setMode("arrive");
  }));
}
$("flight-search").addEventListener("input", () => renderFlight());
$("fl-dir-dep").addEventListener("click", () => { state.flightDir = "dep"; renderFlight(); });
$("fl-dir-arr").addEventListener("click", () => { state.flightDir = "arr"; renderFlight(); });

/* ---------- 選站面板 ---------- */
let picking = null;
function openSheet(which) {
  picking = which;
  $("sheet-title").textContent = t(which === "from" ? "pickOrigin" : which === "to" ? "pickDest" : "pickBoard");
  const cur = which === "board" ? state.boardStation : state[which];
  const locateBtn = geo && navigator.geolocation
    ? `<li class="locate-li"><button class="pick-btn locate-btn" id="btn-locate">${t("locate")}</button></li>`
    : "";
  $("station-list").innerHTML = locateBtn + stations.map((s) => `
      <li><button class="pick-btn ${s.express ? "express" : "local-only"} ${cur === s.id ? "picked" : ""}" data-id="${s.id}">
        <span class="code">${s.id}</span>
        <span><span class="pick-name">${stnName(s.id)}</span><span class="pick-en">${lang === "zh" ? stationById.get(s.id).nameEn : stationById.get(s.id).name}</span></span>
        ${s.express ? `<span class="pick-tag">${t("expressTag")}</span>` : ""}
      </button></li>`).join("");
  $("station-sheet").hidden = false;
  $("sheet-backdrop").hidden = false;
  const lb = $("btn-locate");
  if (lb) lb.onclick = () => locateNearest(lb, (id, km) => {
    lb.textContent = `📍 ${id} ${stnName(id)}・${t("kmAway", km)}`;
    setTimeout(() => {
      if (picking === "board") state.boardStation = id;
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
  if (picking === "board") state.boardStation = btn.dataset.id;
  else { state[picking] = btn.dataset.id; state.flightCtx = null; }
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
  for (const v of ["plan", "board", "flight"]) {
    $(`tab-${v}`).classList.toggle("on", view === v);
    $(`${v}-wrap`).hidden = view !== v;
  }
  if (view === "board") renderBoard();
  else if (view === "flight") renderFlight();
  else runQuery();
}
$("tab-plan").addEventListener("click", () => setView("plan"));
$("tab-board").addEventListener("click", () => setView("board"));
$("tab-flight").addEventListener("click", () => setView("flight"));

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
  $("flight-search").placeholder = t("flightSearchPh");
  $("fav-title").textContent = t("favTitle");
  $("board-title").textContent = t("boardTitle");
  $("map-hint-text").innerHTML = `<span class="dot-demo express"></span>${t("legendExpress")}　<span class="dot-demo"></span>${t("legendLocal")}`;
  $("data-note").innerHTML = `${timetable.dataStatus === "estimate" ? t("dataEstimate") : t("dataOfficial")} · ${t("version")} <code>${timetable.version}</code>`;
  $("lang-sel").value = lang;
}
$("lang-sel").addEventListener("change", (e) => {
  lang = e.target.value;
  localStorage.setItem("tymf-lang", lang);
  t = makeT(lang);
  document.documentElement.lang = lang === "zh" ? "zh-Hant-TW" : lang;
  applyStatic(); refreshOD(); renderFavs();
  state.view === "board" ? renderBoard() : runQuery();
});

/* ---------- 時鐘與自動更新 ---------- */
let lastMin = -1;
function tick() {
  const now = taipeiNow();
  $("clock").innerHTML = `${fmtTime(now.min).slice(0, 2)}<span class="tick">:</span>${fmtTime(now.min).slice(3)}`;
  if (now.min !== lastMin) {
    lastMin = now.min;
    if (state.view === "board") renderBoard();
    else if (state.mode === "now") runQuery();
  }
}
setInterval(tick, 5000);

/* ---------- PWA ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* ---------- 啟動 ---------- */
document.documentElement.lang = lang === "zh" ? "zh-Hant-TW" : lang;
applyStatic();
refreshOD();
renderFavs();
if (state.mode !== "now") { $("custom-time").value = state.custom; setMode(state.mode); }
if (pendingFlightSearch) { $("flight-search").value = pendingFlightSearch; setView("flight"); }
tick();

// 已授權過定位時，靜默預選最近車站（不彈權限視窗）
if (!hashHadFrom && !pendingFlightSearch && geo && navigator.permissions?.query) {
  navigator.permissions.query({ name: "geolocation" }).then((p) => {
    if (p.state !== "granted") return;
    navigator.geolocation.getCurrentPosition((pos) => {
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
    }, () => {}, { timeout: 6000, maximumAge: 300000 });
  }).catch(() => {});
}
