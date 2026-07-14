// Marine Video Portal service worker.
//
// Deliberately minimal: its only job is to make the app installable as a PWA.
// This is a PRIVATE, authenticated, streaming app, so we intentionally cache
// NOTHING — no API responses, no authed HTML, no video. Everything is served
// straight from the network. Caching private content here would risk showing a
// stale or wrong-account view offline, which we never want.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// A fetch handler must exist for the app to be installable. We pass every
// request through to the network unchanged.
self.addEventListener('fetch', () => {
  // no-op: default browser network handling
});
