// offline play: keeps the game's files on the device, one cache per build (sw.js?v=N, so every new
// build installs a fresh worker and drops the old cache).
//   page (navigation): network first, so updates arrive; the cached copy when offline
//   everything else of ours + google fonts: cache first (js/css carry ?v=N, so they never go stale
//   within a build); the page sends the list of files it loaded, so they are cached at once
//   music: streamed with range requests, which the cache can't serve: network only (no music offline)
//   analytics and other sites: untouched
const version = new URL(location).searchParams.get('v') || '0';
const cacheName = `fogtide-${version}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(cacheName).then((c) => c.addAll(['./', './manifest.webmanifest'])));
  self.skipWaiting();
});

// new build active: remove the caches of older builds, take over open pages
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fogtide-') && k !== cacheName).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// { cache: [urls] } from the page: store every file not cached yet (failures are skipped)
self.addEventListener('message', (e) => {
  const urls = e.data?.cache;
  if (!Array.isArray(urls)) return;
  e.waitUntil(caches.open(cacheName).then((c) => Promise.all(urls.map((u) => c.match(u).then((hit) => hit || c.add(u).catch(() => {}))))));
});

const fontHost = /^fonts\.(googleapis|gstatic)\.com$/;

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || req.headers.has('range')) return;   // music streaming: network only
  if (url.origin !== location.origin && !fontHost.test(url.hostname)) return;
  // design mockups: network only (a mockup page must never be cached as the game's start page)
  if (url.pathname.includes('/mockups/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then((res) => { const copy = res.clone(); caches.open(cacheName).then((c) => c.put('./', copy)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(cacheName).then((c) => c.put(req, copy)); }
    return res;
  })));
});
