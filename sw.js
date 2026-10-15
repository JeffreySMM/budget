// Network first, cache as the fallback when offline or the network stalls.
// Fetches bypass the HTTP cache, so online loads are always fresh and there is
// no cache version to bump on deploy.
const CACHE = 'budget-shell';
const NETWORK_TIMEOUT_MS = 4000;
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'logic.js', 'sheet.js',
  'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', event => {
  const requests = SHELL.map(url => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(requests)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request, { cache: 'no-cache', signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => (await caches.match(request, { ignoreSearch: true })) ?? Response.error()),
  );
});
