/* 機捷快轉 Service Worker：離線可用
 * - data/*.json：網路優先（保持班表最新），離線退回快取
 * - 其他資產：快取優先＋背景更新（stale-while-revalidate）
 */
const CACHE = "tymf-v1";
const PRECACHE = [
  ".", "index.html", "manifest.webmanifest",
  "assets/style.css", "assets/app.js", "assets/planner.js", "assets/i18n.js",
  "data/network.json", "data/timetable.json", "data/holidays.json",
  "data/station-names.json", "data/geo.json",
  "icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  if (url.pathname.includes("/data/")) {
    // 班表資料：網路優先
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 資產：快取優先＋背景更新
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
