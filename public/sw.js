// Midnite Sentinel service worker.
// Purpose: make the app installable, receive Web Push, and show an offline page.
// It never caches app pages, assets or API responses: inverter data must always be live.
// The only cached files are the offline page and its icon, used when a navigation fails.
const OFFLINE_CACHE = "sentinel-offline-v1";
const OFFLINE_URL = "/offline.html";
const OFFLINE_ASSETS = [OFFLINE_URL, "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE)
      .then((c) => c.addAll(OFFLINE_ASSETS))
      .catch(() => {}) // never block install on the fallback
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network only. A page navigation that fails (no connection) gets the offline page; nothing else is touched.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  event.respondWith(
    fetch(req).catch(async () => {
      const cached = await caches.match(OFFLINE_URL);
      return cached || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
    })
  );
});

// Push payload: JSON {title, body, url, tag}. Plain text is used as the body.
self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); } catch { data = { body: event.data.text() }; }
  }
  const title = data.title || "Midnite Sentinel";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an open window on the target URL (or any app window, then navigate it), else open a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const exact = wins.find((w) => w.url === target);
    if (exact) return exact.focus();
    const any = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (any) {
      try { await any.navigate(target); } catch { /* uncontrolled window: just focus */ }
      return any.focus();
    }
    return self.clients.openWindow(target);
  })());
});
