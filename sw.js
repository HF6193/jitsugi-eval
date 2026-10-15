// オフライン用キャッシュ。アプリを更新したら VERSION を上げる
const VERSION = "v12";
const CACHE = "jitsugi-eval-" + VERSION;
const ASSETS = [
  "./", "index.html", "style.css", "app.js", "checklist.js", "manifest.webmanifest", "icon-180.png", "icon-512.png",
  // 補足画像（img/ に追加したらここにも書く。deploy.sh が書き忘れを検出する）
  "img/corner-positions.svg", "img/corner-ab.png",
];

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
// ページを開く要求は、URLの違い（/ と /index.html など）に関係なく保存済みの index.html を返す
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith((async () => {
    if (e.request.mode === "navigate") {
      const page = await caches.match("index.html");
      if (page) return page;
    }
    const hit = await caches.match(e.request, { ignoreSearch: true });
    return hit || fetch(e.request);
  })());
});
