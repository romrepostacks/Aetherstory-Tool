// Offline app shell. Bump VERSION when shipping changes so phones pick them up.
const VERSION = 'aetherstory-v7';
const SHELL = ['./', 'index.html', 'app.js', 'lib.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
// Only our own caches are pruned: the built-in model's weights live in WebLLM's caches.
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('aetherstory') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
// Network first so updates land when online; cache when offline. AI calls are cross-origin and untouched.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // The built-in model's library (version-pinned URL) is cached so it also loads offline.
  if (e.request.method === 'GET' && url.host === 'cdn.jsdelivr.net') {
    return e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    })));
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
