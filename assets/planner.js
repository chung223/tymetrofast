/**
 * 轉乘計算引擎（瀏覽器與 Node 共用的 ES module）。
 * 以逐班車時刻做 Connection Scan 最早抵達演算法：
 * 把每班車相鄰停靠站拆成一段段「連結」，依發車時刻掃描，自然涵蓋
 * 直達車+轉乘、甚至「搭過站再折返」（如 A1→坑口 搭直達到 A12 再北上）的路線。
 */

export function fmtTime(min) {
  const m = Math.round(min);
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function buildIndex(network, timetable, dayType) {
  const trains = timetable.dayTypes[dayType];
  if (!trains) throw new Error(`無此日別班表: ${dayType}`);
  // 轉乘緩衝：同方向轉乘＝下車原月台候車即可；折返轉乘通常需換月台（部分車站同月台可折返）
  const transferMin = new Map(
    network.stations.map((s) => [s.id, {
      same: (s.transferSameSec ?? network.defaultTransferSameSec ?? 45) / 60,
      reverse: (s.transferReverseSec ?? network.defaultTransferReverseSec ?? 150) / 60,
    }])
  );
  const connections = [];
  for (const t of trains) {
    for (let i = 0; i < t.stops.length - 1; i++) {
      connections.push({
        trip: t.id,
        type: t.type,
        dir: t.dir,
        from: t.stops[i][0],
        dep: t.stops[i][1],
        to: t.stops[i + 1][0],
        arr: t.stops[i + 1][1],
      });
    }
  }
  connections.sort((a, b) => a.dep - b.dep || a.arr - b.arr);
  const trainById = new Map(trains.map((t) => [t.id, t]));
  return { network, connections, trainById, transferMin, dayType };
}

/** 最早抵達單一行程。回傳 journey 或 null（當日無法抵達）。 */
export function planJourney(index, { from, to, departAfter }) {
  const { connections, transferMin } = index;
  const arrival = new Map();
  const inConn = new Map();
  const boardable = new Set();
  arrival.set(from, departAfter);

  for (const c of connections) {
    if (c.dep < departAfter) continue;
    const arrAtFrom = arrival.get(c.from);
    let buffer = 0;
    if (c.from !== from && arrAtFrom !== undefined) {
      const arrivedDir = inConn.get(c.from)?.dir;
      const tm = transferMin.get(c.from);
      buffer = arrivedDir === c.dir ? tm.same : tm.reverse;
    }
    const canBoard =
      boardable.has(c.trip) ||
      (arrAtFrom !== undefined && arrAtFrom + buffer <= c.dep + 1e-9);
    if (!canBoard) continue;
    boardable.add(c.trip);
    if (c.arr < (arrival.get(c.to) ?? Infinity) - 1e-9) {
      arrival.set(c.to, c.arr);
      inConn.set(c.to, c);
    }
    if ((arrival.get(to) ?? Infinity) < c.dep - 1e-9) break; // 目的地已定案
  }

  if (!inConn.has(to)) return null;

  // 回溯路徑並把同一班車的連續連結合併成一段
  const chain = [];
  let cur = to;
  while (cur !== from) {
    const c = inConn.get(cur);
    if (!c) break;
    chain.unshift(c);
    cur = c.from;
  }
  const legs = [];
  for (const c of chain) {
    const last = legs[legs.length - 1];
    if (last && last.trip === c.trip) {
      last.to = c.to;
      last.arr = c.arr;
      last.hops++;
    } else {
      legs.push({ trip: c.trip, type: c.type, dir: c.dir, from: c.from, dep: c.dep, to: c.to, arr: c.arr, hops: 1 });
    }
  }
  return {
    dep: legs[0].dep,
    arr: legs[legs.length - 1].arr,
    rideMin: legs[legs.length - 1].arr - legs[0].dep,
    transfers: legs.length - 1,
    legs,
  };
}

/** 同班車直達（免轉乘）方案：找最早一班同時停靠起訖站且順向的車。 */
export function planDirect(index, { from, to, departAfter }) {
  let best = null;
  for (const t of index.trainById.values()) {
    const iF = t.stops.findIndex(([id]) => id === from);
    const iT = t.stops.findIndex(([id]) => id === to);
    if (iF < 0 || iT < 0 || iF >= iT) continue;
    const dep = t.stops[iF][1];
    const arr = t.stops[iT][1];
    if (dep < departAfter) continue;
    if (!best || arr < best.arr || (arr === best.arr && dep > best.dep)) {
      best = {
        dep, arr,
        rideMin: arr - dep,
        transfers: 0,
        legs: [{ trip: t.id, type: t.type, dir: t.dir, from, dep, to, arr, hops: iT - iF }],
      };
    }
  }
  return best;
}

/**
 * 趕時間反推：在 arriveBy 前抵達的「最晚出發」行程（找不到回傳 null）。
 * 由起點站發車事件從晚到早逐一嘗試，配合 planJourney 的最早抵達驗證。
 */
export function planArriveBy(index, { from, to, arriveBy }) {
  const deps = [...new Set(
    index.connections.filter((c) => c.from === from && c.dep <= arriveBy).map((c) => c.dep)
  )].sort((a, b) => b - a);
  for (const t of deps) {
    const j = planJourney(index, { from, to, departAfter: t });
    if (j && j.arr <= arriveBy + 1e-9) return j;
  }
  return null;
}

/**
 * 查詢多個接續方案：回傳依出發時刻遞增的前 count 個「不被支配」行程
 * （每個行程都是該出發時刻之後的最早抵達；晚出發但同時抵達者取晚出發）。
 */
export function planOptions(index, { from, to, departAfter, count = 4 }) {
  const out = [];
  let t = departAfter;
  for (let i = 0; i < count * 3 && out.length < count; i++) {
    const j = planJourney(index, { from, to, departAfter: t });
    if (!j) break;
    // 在同樣抵達時刻下，找最晚可出發的班次（避免「早出發乾等」）
    let refined = j;
    while (true) {
      const later = planJourney(index, { from, to, departAfter: refined.dep + 0.5 });
      if (later && later.arr <= j.arr + 1e-9) refined = later;
      else break;
    }
    if (!out.some((o) => o.dep === refined.dep && o.arr === refined.arr)) out.push(refined);
    t = refined.dep + 0.5;
  }
  return out;
}
