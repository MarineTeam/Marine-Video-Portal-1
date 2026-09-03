// Video portal service worker.
//
// This is a PRIVATE, authenticated, streaming app. The service worker ONLY
// caches public, non-sensitive static assets (the app icons) so the app is
// installable and its chrome loads instantly. It never caches API responses,
// authed HTML, or video — those always go to the network, so we can never show a
// stale or wrong-account view.

// Bumped to v3 when the static manifest was removed: existing installs hold a
// v2 cache whose manifest entry is now a 404 and need a fresh one.
const STATIC_CACHE = 'mvp-static-v3';

// NB: the manifest is deliberately NOT precached. It is generated per request
// (/api/manifest) so it carries the admin-set portal name, and caching it here
// would pin the old name on installed apps after a rename. It is also why this
// list must stay 404-free: addAll() rejects as a whole, so one dead entry stops
// the service worker installing at all — taking PWA install and push with it.
const STATIC_ASSETS = [
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

// Web Push: show the notification the server sent. Payload is a JSON string
// { title, body, url }. Guarded so a malformed payload can't crash the handler.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {};
  }
  // Every send from lib/push.js sets an explicit title (which carries the
  // admin-set portal name); this static fallback only covers a malformed
  // payload, and the service worker can't read Redis to personalise it.
  const title = payload.title || 'New notification';
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: payload.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Clicking a notification focuses an existing tab (navigating it to the target)
// or opens a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) {
            try { client.navigate(target); } catch (e) {}
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })
  );
});
