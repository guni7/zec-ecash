// Offline shell for the demo wallet: keeps the page's own files on the device so it opens with
// no network (Step 4, safe offline receive). Network first, so a reload online always gets the
// current code; the cache is only the fallback. Mint (/mint) and point-of-sale (/pos) calls are
// live data and are never cached.
const CACHE = 'zec-ecash-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/mint') || url.pathname.startsWith('/pos')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        if (e.request.mode === 'navigate') return (await caches.match('/')) ?? Response.error();
        return Response.error();
      }),
  );
});
