/**
 * 快轉 即時資料中繼站（Cloudflare Worker）
 * - TDX 金鑰只存在 Worker Secrets，前端永遠拿不到
 * - 記憶體快取 30 秒：所有使用者共用一次 TDX 呼叫（TDX 免費層每分鐘約 5 次）
 * - 上游失敗（429 等）時回傳最近一次成功資料（stale）
 * - ?stn=BL12 伺服端過濾，前端只收該站的到站列
 */
const TDX = "https://tdx.transportdata.tw/api/basic/v2";
const PATHS = {
  "/trtc-live": `${TDX}/Rail/Metro/LiveBoard/TRTC?%24format=JSON`,
  "/tymc-live": `${TDX}/Rail/Metro/LiveBoard/TYMC?%24format=JSON`,
};
const TTL = 30000;

const mem = new Map(); // path -> { body(string), at }
let tokenCache = { v: null, exp: 0 };

async function getToken(env) {
  if (tokenCache.v && Date.now() < tokenCache.exp) return tokenCache.v;
  const r = await fetch("https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.TDX_CLIENT_ID,
      client_secret: env.TDX_CLIENT_SECRET,
    }),
  });
  if (!r.ok) throw new Error(`token ${r.status}`);
  const j = await r.json();
  tokenCache = { v: j.access_token, exp: Date.now() + ((j.expires_in ?? 3600) - 300) * 1000 };
  return tokenCache.v;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "content-type": "application/json; charset=utf-8",
};
const reply = (body, tag, status = 200) =>
  new Response(body, { status, headers: { ...CORS, "x-cache": tag, "cache-control": "public, max-age=15" } });

function filterStn(body, stn) {
  if (!stn) return body;
  try {
    const arr = JSON.parse(body);
    if (!Array.isArray(arr)) return body;
    return JSON.stringify(arr.filter((x) => (x.StationID ?? "") === stn));
  } catch {
    return body;
  }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const target = PATHS[url.pathname];
    if (!target) return reply(JSON.stringify({ paths: Object.keys(PATHS) }), "index", 404);
    const stn = url.searchParams.get("stn") ?? "";

    const hit = mem.get(url.pathname);
    if (hit && Date.now() - hit.at < TTL) return reply(filterStn(hit.body, stn), "hit");

    try {
      const token = await getToken(env);
      const up = await fetch(target, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      if (!up.ok) throw new Error(`upstream ${up.status}`);
      const body = await up.text();
      mem.set(url.pathname, { body, at: Date.now() });
      return reply(filterStn(body, stn), "miss");
    } catch (e) {
      if (hit) return reply(filterStn(hit.body, stn), "stale"); // 限流時退回稍舊資料
      return reply(JSON.stringify({ error: String(e.message ?? e) }), "err", 502);
    }
  },
};
