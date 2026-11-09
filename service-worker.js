const CACHE_NAME = "ht-product-pwa-v3";
const APP_FILES = [
  "./",
  "./index.html",
  "./app.css?v=3",
  "./app.js?v=3",
  "./data-utils.js?v=3",
  "./exhibition-export.js?v=3",
  "./storage.js",
  "./importer.js",
  "./manifest.webmanifest",
  "./assets/logo.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./vendor/sql-wasm.js",
  "./vendor/sql-wasm.wasm",
  "./vendor/exceljs.min.js?v=3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const refreshed = fetch(event.request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
        return response;
      }).catch(() => cached);
      return cached || refreshed;
    })
  );
});
