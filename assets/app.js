/* 機捷快轉 · 前端主程式 */
import { buildIndex, planDirect, planOptions, fmtTime } from "./planner.js";

const $ = (id) => document.getElementById(id);

const [network, timetable, holidaysFile] = await Promise.all(
  ["data/network.json", "data/timetable.json", "data/holidays.json"].map((u) =>
    fetch(u).then((r) => {
      if (!r.ok) throw new Error(`載入失敗 ${u}`);
      return r.json();
    })
  )
);
const holidays = new Set(holidaysFile.holidays);
const stations = network.stations;
const stationById = new Map(stations.map((s) => [s.id, s]));
const indexCache = new Map();
const getIndex = (dayType) => {
  if (!indexCache.has(dayType)) indexCache.set(dayType, buildIndex(network, timetable, dayType));
  return indexCache.get(dayType);
};

/* ---------- 台灣時間 ---------- */
function taipeiNow() {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }); // YYYY-MM-DD HH:mm:ss
  return { date: s.slice(0, 10), min: Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16)) };
}
function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dayTypeOf(dateStr) {
  if (holidays.has(dateStr)) return "holiday";
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6 ? "holiday" : "weekday";
}

/* ---------- 狀態 ---------- */
const state = { from: "A1", to: "A16", mode: "now", custom: null };
(function initFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (stationById.has(p.get("from"))) state.from = p.get("from");
  if (stationById.has(p.get("to"))) state.to = p.get("to");
  if (p.get("t") && p.get("t") !== "now") { state.mode = "custom"; state.custom = p.get("t"); }
})();
function syncHash() {
  const t = state.mode === "now" ? "now" : state.custom ?? "now";
  history.replaceState(null, "", `#from=${state.from}&to=${state.to}&t=${t}`);
}

/* ---------- 查詢 ---------- */
function queryContext() {
  if (state.mode === "now") return taipeiNow();
  const v = state.custom;
  if (!v) return taipeiNow();
  return { date: v.slice(0, 10), min: Number(v.slice(11, 13)) * 60 + Number(v.slice(14, 16)) };
}

function candidatesFor(ctx) {
  const list = [{ dayType: dayTypeOf(ctx.date), departAfter: ctx.min, dayOffset: 0 }];
  if (ctx.min < 180) {
    list.push({ dayType: dayTypeOf(shiftDate(ctx.date, -1)), departAfter: ctx.min + 1440, dayOffset: -1 });
  }
  return list;
}

function runQuery() {
  const { from, to } = state;
  const ctx = queryContext();
  const dayType = dayTypeOf(ctx.date);
  $("daytype-chip").textContent = `${ctx.date.slice(5).replace("-", "/")} ${dayType === "weekday" ? "平日" : "假日"}班表`;

  if (from === to) {
    renderResults({ error: "起點與訖點相同，請選擇不同車站。" });
    return;
  }

  const collect = (cands, count) => {
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
        if (!direct || d.arr + d.dayOffset * 1440 < direct.arr + direct.dayOffset * 1440) direct = d;
      }
    }
    opts.sort((a, b) => (a.arr + a.dayOffset * 1440) - (b.arr + b.dayOffset * 1440) || (b.dep + b.dayOffset * 1440) - (a.dep + a.dayOffset * 1440));
    // 去除被支配方案（晚發又晚到）
    const clean = [];
    for (const o of opts) {
      if (!clean.some((k) => k.dep + k.dayOffset * 1440 >= o.dep + o.dayOffset * 1440 && k.arr + k.dayOffset * 1440 <= o.arr + o.dayOffset * 1440)) clean.push(o);
    }
    return { options: clean.slice(0, 4), direct };
  };

  let { options, direct } = collect(candidatesFor(ctx), 4);
  let nextDay = null;
  if (!options.length) {
    const d1 = shiftDate(ctx.date, 1);
    const r = collect([{ dayType: dayTypeOf(d1), departAfter: 0, dayOffset: 1 }], 2);
    options = r.options;
    direct = r.direct;
    nextDay = d1;
  }
  renderResults({ options, direct, nextDay });
  renderMap(options[0] ?? null);
}

/* ---------- 呈現 ---------- */
const stnLabel = (id) => `${id} ${stationById.get(id).name}`;
function transferHint(stationId, fromDir, toDir) {
  const s = stationById.get(stationId);
  if (fromDir === toDir) return "原月台候車即可";
  const sec = s.transferReverseSec ?? network.defaultTransferReverseSec ?? 150;
  return sec <= 90 ? "同月台即可折返" : "";
}

function legHtml(leg, journey, i) {
  const train = leg.type === "express" ? "直達車" : "普通車";
  const skip = leg.type === "express" ? "中途過站不停部分車站" : `沿途停靠 ${leg.hops - 1} 站`;
  const dirTxt = leg.dir === "S" ? "往老街溪方向" : "往台北方向";
  let html = `
    <div class="leg ${leg.type}">
      <div class="leg-rail"></div>
      <div class="leg-body">
        <div class="leg-line1">
          <span class="train-chip">${train}</span>
          <span class="leg-time">${fmtTime(leg.dep)}</span>
          <span class="leg-stations">${stnLabel(leg.from)} 上車</span>
        </div>
        <div class="leg-detail">${dirTxt} · ${leg.hops === 1 ? "下一站即到" : skip} · 乘車 ${Math.round(leg.arr - leg.dep)} 分</div>
      </div>
    </div>`;
  const next = journey.legs[i + 1];
  if (next) {
    const wait = Math.round(next.dep - leg.arr);
    const hint = transferHint(leg.to, leg.dir, next.dir);
    html += `
      <div class="transfer-row">
        <span><b>${stnLabel(leg.to)}</b>（${fmtTime(leg.arr)} 到）轉乘 · 等 ${wait} 分</span>
        ${hint ? `<span class="same-platform">${hint}</span>` : ""}
      </div>`;
  } else {
    html += `
      <div class="alight-row">
        <span class="leg-time">${fmtTime(leg.arr)}</span>
        <span class="leg-stations">${stnLabel(leg.to)} 抵達</span>
      </div>`;
  }
  return html;
}

function journeyCard(j, { badge, badgeAlt, saveMin, nextDay } = {}) {
  const total = Math.round(j.arr - j.dep);
  return `
  <article class="panel journey-card ${badgeAlt ? "" : "best"}">
    <div class="jc-head">
      <span class="jc-badge ${badgeAlt ? "alt" : ""}">${badge}</span>
      ${nextDay ? `<span class="nextday-chip">明日 ${nextDay.slice(5).replace("-", "/")}</span>` : ""}
      <span class="jc-times">${fmtTime(j.dep)}<span class="jc-arrow">▶</span><span class="arr">${fmtTime(j.arr)}</span></span>
      <span class="jc-meta"><b>${total} 分</b> · ${j.transfers ? `轉乘 ${j.transfers} 次` : "免轉乘"}
        ${saveMin > 0 ? ` · <span class="save-chip">快 ${saveMin} 分</span>` : ""}</span>
    </div>
    <div class="legs">${j.legs.map((l, i) => legHtml(l, j, i)).join("")}</div>
  </article>`;
}

function renderResults({ options, direct, nextDay, error }) {
  const box = $("results");
  if (error) {
    box.innerHTML = `<div class="panel empty-card">${error}</div>`;
    renderMap(null);
    return;
  }
  if (!options.length) {
    box.innerHTML = `<div class="panel empty-card">查無班次 😴</div>`;
    return;
  }
  const best = options[0];
  let html = "";
  if (nextDay) {
    html += `<div class="panel empty-card">今日已無可抵達的班次，為你找出<b>明日首班</b>方案：</div>`;
  }
  const directIsBest = direct && direct.dep === best.dep && direct.arr === best.arr && best.transfers === 0;
  const saveMin = direct ? Math.round(direct.arr + direct.dayOffset * 1440 - (best.arr + best.dayOffset * 1440)) : 0;
  html += journeyCard(best, { badge: "最快抵達", saveMin, nextDay });

  if (direct && !directIsBest && best.transfers > 0) {
    html += journeyCard(direct, { badge: "免轉乘方案", badgeAlt: true, nextDay });
  }
  const rest = options.slice(1).filter((o) => !(direct && o.dep === direct.dep && o.arr === direct.arr && o.transfers === 0));
  if (rest.length) {
    html += `<h3 class="options-title">接續班次</h3>`;
    for (const o of rest) html += journeyCard(o, { badge: "下一班", badgeAlt: true, nextDay });
  }
  box.innerHTML = html;
}

/* ---------- 路線圖 ---------- */
function renderMap(journey) {
  const svg = $("line-map");
  const n = stations.length;
  const W = Math.max(690, svg.clientWidth || 690);
  const PAD = 26, Y = 40;
  const x = (i) => PAD + (i * (W - PAD * 2)) / (n - 1);
  const pos = new Map(stations.map((s, i) => [s.id, i]));
  let g = "";

  // 主線
  g += `<line x1="${PAD}" y1="${Y}" x2="${W - PAD}" y2="${Y}" stroke="#3a4666" stroke-width="5" stroke-linecap="round"/>`;

  // 行程覆蓋層（每一段一條，折返段往下偏移）
  if (journey) {
    journey.legs.forEach((leg, li) => {
      const x1 = x(pos.get(leg.from)), x2 = x(pos.get(leg.to));
      const y = Y + (li > 0 && leg.dir !== journey.legs[0].dir ? 9 : 0);
      const color = leg.type === "express" ? "var(--purple)" : "var(--blue)";
      g += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}" stroke-width="7" stroke-linecap="round" opacity="0.95"/>`;
      g += `<line class="flow" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`;
      const mid = (x1 + x2) / 2;
      g += `<polygon points="${mid - 5},${y - 4} ${mid - 5},${y + 4} ${mid + 4},${y}" fill="#0c111c" transform="${x2 < x1 ? `rotate(180 ${mid} ${y})` : ""}"/>`;
    });
  }

  // 車站點與代碼
  stations.forEach((s, i) => {
    const cx = x(i);
    const isEx = s.express;
    const inJourney = journey && journey.legs.some((l) => l.from === s.id || l.to === s.id);
    const r = isEx ? 6 : 4.5;
    const ring = isEx ? "var(--purple)" : "var(--blue)";
    g += `<circle cx="${cx}" cy="${Y}" r="${r}" fill="${inJourney ? "var(--amber)" : "#fff"}" stroke="${ring}" stroke-width="2.5"/>`;
    g += `<text x="${cx}" y="${Y + 22}" transform="rotate(-52 ${cx} ${Y + 22})" text-anchor="end"
      font-size="10" font-family="Chakra Petch, sans-serif" font-weight="600"
      fill="${inJourney ? "var(--amber)" : "#93a1bb"}">${s.id}</text>`;
  });

  // 起訖/轉乘站站名標籤（相鄰時分兩層避免重疊）
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
      const color = kind === "轉" ? "var(--amber)" : "var(--green)";
      g += `<text x="${cx}" y="${tier === 1 ? Y - 12 : Y - 26}" text-anchor="middle" font-size="11" font-weight="700"
        font-family="Noto Sans TC, sans-serif" fill="${color}">${stationById.get(id).name}</text>`;
    }
  }

  svg.setAttribute("viewBox", `0 0 ${W} 104`);
  svg.innerHTML = g;

  // 手機上自動捲到行程範圍
  if (journey) {
    const xs = journey.legs.flatMap((l) => [x(pos.get(l.from)), x(pos.get(l.to))]);
    const scroller = svg.closest(".line-map-scroll");
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    scroller.scrollTo({ left: (mid / W) * svg.scrollWidth - scroller.clientWidth / 2, behavior: "smooth" });
  }
}

/* ---------- 選站面板 ---------- */
let picking = null;
function openSheet(which) {
  picking = which;
  $("sheet-title").textContent = which === "from" ? "選擇出發站" : "選擇前往站";
  const list = $("station-list");
  list.innerHTML = stations
    .map((s) => `
      <li><button class="pick-btn ${s.express ? "express" : "local-only"} ${state[which] === s.id ? "picked" : ""}" data-id="${s.id}">
        <span class="code">${s.id}</span>
        <span><span class="pick-name">${s.name}</span><span class="pick-en">${s.nameEn}</span></span>
        ${s.express ? '<span class="pick-tag">直達車停靠</span>' : ""}
      </button></li>`)
    .join("");
  $("station-sheet").hidden = false;
  $("sheet-backdrop").hidden = false;
  list.querySelector(".picked")?.scrollIntoView({ block: "center" });
}
function closeSheet() {
  $("station-sheet").hidden = true;
  $("sheet-backdrop").hidden = true;
  picking = null;
}
$("station-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-id]");
  if (!btn || !picking) return;
  state[picking] = btn.dataset.id;
  closeSheet();
  refreshOD();
  syncHash();
  runQuery();
});
$("sheet-backdrop").addEventListener("click", closeSheet);
addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());

/* ---------- 控制列 ---------- */
function refreshOD() {
  for (const w of ["from", "to"]) {
    $(`${w}-code`).textContent = state[w];
    $(`${w}-name`).textContent = stationById.get(state[w]).name;
  }
}
$("btn-from").addEventListener("click", () => openSheet("from"));
$("btn-to").addEventListener("click", () => openSheet("to"));
$("btn-swap").addEventListener("click", () => {
  [state.from, state.to] = [state.to, state.from];
  refreshOD(); syncHash(); runQuery();
});
function setMode(mode) {
  state.mode = mode;
  $("mode-now").classList.toggle("on", mode === "now");
  $("mode-now").setAttribute("aria-selected", mode === "now");
  $("mode-custom").classList.toggle("on", mode === "custom");
  $("mode-custom").setAttribute("aria-selected", mode === "custom");
  const dt = $("custom-time");
  dt.hidden = mode !== "custom";
  if (mode === "custom" && !dt.value) {
    const now = taipeiNow();
    dt.value = state.custom ?? `${now.date}T${fmtTime(now.min)}`;
    state.custom = dt.value;
  }
  syncHash(); runQuery();
}
$("mode-now").addEventListener("click", () => setMode("now"));
$("mode-custom").addEventListener("click", () => setMode("custom"));
$("custom-time").addEventListener("change", (e) => {
  state.custom = e.target.value;
  syncHash(); runQuery();
});

/* ---------- 時鐘與自動更新 ---------- */
let lastMin = -1;
function tick() {
  const now = taipeiNow();
  $("clock").innerHTML = `${fmtTime(now.min).slice(0, 2)}<span class="tick">:</span>${fmtTime(now.min).slice(3)}`;
  if (state.mode === "now" && now.min !== lastMin) {
    lastMin = now.min;
    runQuery();
  }
}
setInterval(tick, 5000);

/* ---------- 資料版本註記 ---------- */
$("data-note").innerHTML =
  (timetable.dataStatus === "estimate"
    ? `<span class="warn">⚠ 目前為推估班表</span>（依官方公告班距與行駛時間推算，誤差可能 1–3 分鐘）。`
    : `✓ 官方時刻表資料。`) +
  ` 資料版本 <code>${timetable.version}</code>`;

/* ---------- 啟動 ---------- */
refreshOD();
if (state.mode === "custom") setMode("custom");
tick();
