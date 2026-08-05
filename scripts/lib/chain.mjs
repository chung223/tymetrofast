/**
 * 把「各站發車事件」串連成逐班車的共用演算法。
 *
 * 同車種同方向的列車不會互相超車，因此每站的事件與進行中列車保持相同順序；
 * 用順序保持的最小成本對齊（DP），能抵抗「尖峰密班＋待避延誤」造成的匹配歧義。
 */

/**
 * @param {Object} opts
 * @param {Map<string, {t:number, dest:string|null}[]>} opts.byStation 站別事件（發車時刻，分鐘）
 * @param {string[]} opts.seqAll 該方向的完整車站順序（含無事件站）
 * @param {Set<string>} opts.terminals 可作為終點站者（收班時補終點到站時刻用）
 * @param {Set<string>} opts.origins 常見中途始發站（新班車出現在這些站不罰分）
 * @param {(a:string,b:string)=>number} opts.runBetween 兩停靠站間預估行駛分鐘
 * @param {(id:string)=>number} opts.lineIndex 車站在路線上的索引
 * @param {number} [opts.maxTerminalGap=2] 收班補終點時允許的最大站距
 * @returns {{stops:[string,number][], dest:string|null}[]}
 */
export function chainEvents({ byStation, seqAll, terminals, origins, runBetween, lineIndex, maxTerminalGap = 2 }) {
  const seq = seqAll.filter((id) => byStation.get(id)?.length);
  const dirSign = seq.length >= 2 ? Math.sign(lineIndex(seq[1]) - lineIndex(seq[0])) : 1;
  const WIN_EARLY = 2, WIN_LATE = 9;
  const trains = [];
  let open = [];

  const closeTrain = (tr) => {
    const last = tr.stops[tr.stops.length - 1][0];
    let terminal = tr.dest ?? null;
    if (!terminal || lineIndex(terminal) === undefined) {
      const li = seqAll.indexOf(last);
      terminal = seqAll.slice(li + 1).find((id) => terminals.has(id)) ?? null;
    }
    if (terminal && terminal !== last) {
      const gap = Math.abs(lineIndex(terminal) - lineIndex(last));
      const forward = Math.sign(lineIndex(terminal) - lineIndex(last)) === dirSign;
      if (forward && gap <= maxTerminalGap) {
        tr.stops.push([terminal, Math.round((tr.cursor + runBetween(last, terminal)) * 2) / 2]);
      }
    }
    if (tr.stops.length >= 2) trains.push(tr);
  };

  for (const sid of seq) {
    const evs = byStation.get(sid).slice().sort((a, b) => a.t - b.t);
    open.sort((a, b) => a.cursor - b.cursor);

    const active = [];
    for (const tr of open) {
      if (tr.dest && tr.dest === tr.stops[tr.stops.length - 1][0]) closeTrain(tr);
      else active.push(tr);
    }

    const n = active.length, m = evs.length;
    const exps = active.map((tr) => tr.cursor + runBetween(tr.stops[tr.stops.length - 1][0], sid));
    const matchCost = (i, j) => {
      const dev = evs[j].t - exps[i];
      return dev < -WIN_EARLY || dev > WIN_LATE ? Infinity : Math.abs(dev);
    };
    const closeCost = (i) => {
      const tr = active[i];
      const last = tr.stops[tr.stops.length - 1][0];
      if (tr.dest === last) return 0;
      const li = lineIndex(last);
      const nearTerminal = [...terminals].some(
        (t) => Math.abs(lineIndex(t) - li) <= maxTerminalGap && Math.sign(lineIndex(t) - li || dirSign) === dirSign
      );
      return nearTerminal ? 3 : 30;
    };
    const newCost = origins.has(sid) ? 1 : 30;
    const INF = Infinity;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
    const via = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0)); // 1=match 2=close 3=new
    dp[0][0] = 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        if (dp[i][j] === INF) continue;
        if (i < n && j < m) {
          const c = dp[i][j] + matchCost(i, j);
          if (c < dp[i + 1][j + 1]) { dp[i + 1][j + 1] = c; via[i + 1][j + 1] = 1; }
        }
        if (i < n) {
          const c = dp[i][j] + closeCost(i);
          if (c < dp[i + 1][j]) { dp[i + 1][j] = c; via[i + 1][j] = 2; }
        }
        if (j < m) {
          const c = dp[i][j] + newCost;
          if (c < dp[i][j + 1]) { dp[i][j + 1] = c; via[i][j + 1] = 3; }
        }
      }
    }
    const ops = [];
    for (let i = n, j = m; i > 0 || j > 0; ) {
      const v = via[i][j];
      ops.unshift(v);
      if (v === 1) { i--; j--; }
      else if (v === 2) i--;
      else j--;
    }
    const nextOpen = [];
    let i = 0, j = 0;
    for (const v of ops) {
      if (v === 1) {
        const tr = active[i];
        tr.stops.push([sid, evs[j].t]);
        tr.cursor = evs[j].t;
        if (!tr.dest && evs[j].dest) tr.dest = evs[j].dest;
        nextOpen.push(tr);
        i++; j++;
      } else if (v === 2) {
        closeTrain(active[i]);
        i++;
      } else {
        nextOpen.push({ stops: [[sid, evs[j].t]], cursor: evs[j].t, dest: evs[j].dest || null });
        j++;
      }
    }
    open = nextOpen;
  }
  for (const tr of open) closeTrain(tr);
  return trains;
}
