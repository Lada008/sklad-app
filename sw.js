const CACHE_VERSION = 'sklad-app-v8';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './js/app.js',
  './js/domain.js',
  './js/gas-api.js',
  './js/storage.js',
  './js/ukzuz.js',
  './js/wake-lock.js',
  './js/xlsx-parser.js',
  './js/ui-search.js',
  './js/ui-orders.js',
  './js/ui-expirations.js',
  './js/ui-inventory.js',
  './js/ui-reports.js',
  './js/ui-data.js',
  './data/stock.json',
  './public/data/por_aktualni.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first pro všechny soubory aplikace i data: při připojení vždy čerstvá verze, offline fallback z cache
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
