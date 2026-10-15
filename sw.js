// オフライン用キャッシュ。アプリを更新したら VERSION を上げる
const VERSION = "v6";
const CACHE = "jitsugi-eval-" + VERSION;
const ASSETS = ["./", "index.html", "style.css", "app.js", "checklist.js", "manifest.webmanifest", "icon-180.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  // ブラウザのHTTPキャッシュに残った古いファイルを取り込まないよう、必ずサーバーから取得する
  const reqs = ASSETS.map((u) => new Request(u, { cache: "reload" }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(reqs)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// キャッシュ優先（ネットがなくても起動できる）
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
