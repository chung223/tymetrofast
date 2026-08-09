/**
 * 台北捷運班距制路徑引擎（瀏覽器與 Node 共用）。
 * 北捷無逐班時刻表：以「站間行駛時間＋轉乘步行時間＋期望等車（班距/2）」
 * 建圖跑 Dijkstra，節點為「站×線」，時間依到達節點時刻查當時段班距。
 * 結果為推估值（±2–3 分），介面須誠實標示。
 */

/** 建圖：nodes Map<"stn|line", edges[]>；edge = {to, ride, walk, boardLine} */
export function buildTrtcGraph(data) {
  const nodes = new Map();
  const edge = (a, b, e) => {
    if (!nodes.has(a)) nodes.set(a, []);
    nodes.get(a).push({ to: b, ...e });
  };
  // 同線相鄰站（雙向）
  for (const [lineId, line] of Object.entries(data.lines ?? {})) {
    for (const [a, b, min] of line.s2s ?? []) {
      edge(`${a}|${lineId}`, `${b}|${lineId}`, { ride: min });
      edge(`${b}|${lineId}`, `${a}|${lineId}`, { ride: min });
    }
  }
  // 轉乘（站內步行，上車前需等目標線班距/2）
  for (const [fs, ts, fl, tl, walk] of data.transfers ?? []) {
    if (nodes.has(`${fs}|${fl}`) && nodes.has(`${ts}|${tl}`)) {
      edge(`${fs}|${fl}`, `${ts}|${tl}`, { ride: 0, walk, boardLine: tl });
    }
  }
  // 站→線索引（起點上車用）
  const linesAt = new Map();
  for (const key of nodes.keys()) {
    const [stn, line] = key.split("|");
    if (!linesAt.has(stn)) linesAt.set(stn, new Set());
    linesAt.get(stn).add(line);
  }
  return { nodes, linesAt };
}

/** 查某線於某時刻的班距（分）；freq 列 = [line, days7字串, "HH:MM", "HH:MM", headway] */
export function headwayOf(data, lineId, minOfDay, holiday) {
  const dow = holiday ? 6 : 2; // 查表用：平日取週三、假日取週日
  let best = null;
  for (const [line, days, s, e, hw] of data.freq ?? []) {
    if (line !== lineId || days[dow] !== "1") continue;
    const sm = Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
    const em = Number(e.slice(0, 2)) * 60 + Number(e.slice(3, 5));
    const m = minOfDay % 1440;
    const inWin = sm <= em ? m >= sm && m < em : m >= sm || m < em; // 跨午夜
    if (inWin) { best = hw; break; }
  }
  return best ?? 6;
}

/**
 * 規劃：{from, to, min（當日第幾分）, holiday} → {totalMin, waitMin, legs} | null
 * legs = [{line, from, to, rideMin, waitMin, stops}]
 */
export function planTrtc(data, graph, { from, to, min, holiday, banLines }) {
  if (from === to) return null;
  const { nodes, linesAt } = graph;
  if (!linesAt.has(from) || !linesAt.has(to)) return null;
  const dist = new Map(), prev = new Map();
  const pq = [];
  for (const line of linesAt.get(from)) {
    if (banLines?.has(line)) continue;
    const wait = headwayOf(data, line, min, holiday) / 2;
    const key = `${from}|${line}`;
    dist.set(key, wait);
    prev.set(key, { via: null, wait });
    pq.push([wait, key]);
  }
  while (pq.length) {
    let bi = 0;
    for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
    const [d, key] = pq.splice(bi, 1)[0];
    if (d > (dist.get(key) ?? Infinity)) continue;
    const [stn, curLine] = key.split("|");
    if (stn === to) continue; // 到站後不再外擴（仍讓其他線節點收斂）
    for (const e of nodes.get(key) ?? []) {
      if (banLines?.has(e.walk != null ? e.boardLine : curLine)) continue;
      let cost = e.ride;
      let wait = 0;
      if (e.walk != null) {
        wait = headwayOf(data, e.boardLine, min + d + e.walk, holiday) / 2;
        cost = e.walk + wait;
      }
      const nd = d + cost;
      if (nd < (dist.get(e.to) ?? Infinity) - 1e-9) {
        dist.set(e.to, nd);
        prev.set(e.to, { via: key, wait: e.walk != null ? wait : 0, walk: e.walk ?? 0 });
        pq.push([nd, e.to]);
      }
    }
  }
  // 目的站取最快的線節點
  let end = null, endD = Infinity;
  for (const line of linesAt.get(to)) {
    const d = dist.get(`${to}|${line}`);
    if (d != null && d < endD) { endD = d; end = `${to}|${line}`; }
  }
  if (!end) return null;
  // 回溯 → 合併同線
  const chain = [];
  for (let cur = end; cur; cur = prev.get(cur)?.via) chain.unshift({ key: cur, meta: prev.get(cur) });
  const legs = [];
  for (let i = 0; i < chain.length; i++) {
    const [stn, line] = chain[i].key.split("|");
    const last = legs[legs.length - 1];
    if (last && last.line === line && !chain[i].meta?.walk) {
      last.to = stn;
      last.stops++;
    } else {
      legs.push({
        line, from: stn, to: stn, stops: 0,
        waitMin: Math.round((chain[i].meta?.wait ?? 0) * 10) / 10,
        walkMin: Math.round((chain[i].meta?.walk ?? 0) * 10) / 10,
      });
    }
  }
  const rides = legs.filter((l) => l.stops > 0);
  if (!rides.length) return null;
  // 各段乘車時間（由節點距離差回推）
  let acc = 0;
  for (const l of legs) {
    const dTo = dist.get(`${l.to}|${l.line}`) ?? 0;
    l.rideMin = Math.round((dTo - acc - l.waitMin - l.walkMin) * 10) / 10;
    acc = dTo;
  }
  return {
    totalMin: Math.round(endD),
    transfers: rides.length - 1,
    legs: rides.map((l) => ({
      line: l.line, from: l.from, to: l.to,
      rideMin: Math.max(0, l.rideMin), waitMin: l.waitMin, walkMin: l.walkMin, stops: l.stops,
    })),
  };
}

/**
 * 多方案：先取最佳路線，再逐一封鎖它用到的每條線找「走別條線」的替代，
 * 去重後依總時間排序取前三。北捷許多起訖本就有兩三種合理走法。
 */
export function planTrtcAlts(data, graph, opts) {
  const best = planTrtc(data, graph, opts);
  if (!best) return [];
  const sig = (r) => r.legs.map((l) => `${l.line}:${l.from}-${l.to}`).join("|");
  const out = [best];
  const seen = new Set([sig(best)]);
  for (const line of new Set(best.legs.map((l) => l.line))) {
    const alt = planTrtc(data, graph, { ...opts, banLines: new Set([line]) });
    if (alt && !seen.has(sig(alt))) { seen.add(sig(alt)); out.push(alt); }
  }
  return out.sort((a, b) => a.totalMin - b.totalMin).slice(0, 3);
}
