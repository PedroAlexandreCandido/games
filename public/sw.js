// Network-first, so a new deploy shows up straight away. The cached copy only
// lets the installed app open while offline; playing always needs the server,
// so the login API and the game socket are never touched.
const CACHE = 'pong-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request, { ignoreSearch: true });
        // Every page, room links included, is the same app shell.
        return cached ?? (event.request.mode === 'navigate' ? caches.match('/', { ignoreSearch: true }) : undefined);
      }),
  );
});
