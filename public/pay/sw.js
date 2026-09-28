// TrueStay Pay service worker
//  - keeps the app shell available for a fast, app-like start (network first, cached copy if offline; never touches /api)
//  - shows the morning nudge and keeps the app-icon badge up to date
const CACHE = "ts-pay-v4";
const SHELL = ["./", "app.css?v=4", "app.js?v=4", "manifest.webmanifest", "icons/apple-touch-icon.png", "icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ts-pay-") && k !== CACHE).map((k) => caches.delete(k)))) // leave other apps' caches alone
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/pay/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./")))
  );
});

// Morning nudge
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  const jobs = [
    self.registration.showNotification(d.title || "TrueStay Pay", {
      body: d.body || "",
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      tag: d.tag || "nudge",
      data: { url: d.url || "./" },
    }),
  ];
  if (typeof d.badge === "number" && self.navigator && "setAppBadge" in self.navigator) {
    jobs.push((d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}));
  }
  e.waitUntil(Promise.all(jobs));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) if (w.url.startsWith(self.registration.scope) && "focus" in w) return w.focus();
      return self.clients.openWindow(url);
    })
  );
});
