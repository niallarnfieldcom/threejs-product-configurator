// Minimal service worker — satisfies PWA installability with a fetch handler.
// Network pass-through (no caching) to avoid stale assets; add a real cache
// strategy here for true offline support later.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {}); // pass-through → browser uses the network
