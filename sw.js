const CACHE_VERSION = 'sklad-app-v5';
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

  // Pro denně aktualizovaná data (stock.json a por_aktualni.json) preferuj síť, při offline vrať cache
  if (
    url.pathname.endsWith('stock.json') ||
    url.pathname.endsWith('por_aktualni.json')
  ) {
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
    return;
  }

  // Pro aplikační soubory: cache-first + tichá aktualizace na pozadí (stale-while-revalidate)
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
