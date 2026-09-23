// Torn Stock Alerts — service worker
// Strategy:
//  - HTML pages (index.html, docs.html, navigations): NETWORK-FIRST. Always tries to fetch the
//    latest version first; only falls back to whatever's cached if the network request fails
//    (e.g. offline). This is the fix for "back to app opens an old version" — no more manual
//    cache-name bumping needed on every deploy.
//  - Static assets (icons, manifest): CACHE-FIRST, since these rarely change and it's fine to
//    serve them instantly from cache.
//
// CACHE_VERSION only needs bumping if you rename/remove files in STATIC_ASSETS below.
const CACHE_VERSION = 'v4';
const CACHE_NAME = `torn-stock-alerts-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  'icon-192.png',
  'icon-512.png',
  'icon-192-maskable.png',
  'icon-512-maskable.png',
  'manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Only this app's own origin gets touched by this service worker at all. Anything
  // cross-origin — api.torn.com, Firebase, Tornsy — is left completely alone and always
  // goes straight to the network, uncached. This was the real bug behind "sync shows stale
  // data": the old rule below caught *every* GET request, including calls to Torn's API,
  // so a previously-cached API response could get served instead of a fresh one.
  if (new URL(req.url).origin !== self.location.origin) return;

  const isNavigation = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isNavigation) {
    // Network-first for pages: always get the freshest HTML when online.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('index.html')))
    );
    return;
  }

  // Cache-first for this app's own static assets (icons, manifest, etc.)
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
      return res;
    }))
  );
});
