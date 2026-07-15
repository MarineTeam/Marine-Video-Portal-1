// Marine Video Portal service worker.
//
// This is a PRIVATE, authenticated, streaming app. The service worker ONLY
// caches public, non-sensitive static assets (app icons + manifest) so the app
// is installable and its chrome loads instantly. It never caches API responses,
// authed HTML, or video — those always go to the network, so we can never show a
// stale or wrong-account view.

const STATIC_CACHE = 'mvp-static-v2';
const STATIC_ASSETS = [
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only serve our own static assets from cache; pass everything else (pages,
  // /api, Bunny video, Auth0) straight to the network untouched.
  if (url.origin === self.location.origin && STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
  }
});
