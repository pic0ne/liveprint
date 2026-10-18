import type { Precache } from './typst/files';

declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE: Precache;

const { version, files, fontsVersion } = __PRECACHE;
const CACHE = `liveprint-${version}`;
const FONT_CACHE = `liveprint-fonts-${fontsVersion}`;
const scope = self.registration.scope;
const FONTS = new URL('fonts/', scope).href;
/** The HTML entry is stored under the scope URL, which is what a navigation to the app asks for. */
const urlOf = (file: string) => new URL(file === 'index.html' ? '' : file, scope).href;
const precached = new Set(files.map(urlOf));

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Revalidates against the HTTP cache, so files the page just downloaded are not downloaded again.
      await cache.addAll([...precached].map((url) => new Request(url, { cache: 'no-cache' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const stale = (await caches.keys()).filter((name) => name.startsWith('liveprint-') && name !== CACHE && name !== FONT_CACHE);
      await Promise.all(stale.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/** Answers from `cacheName`. Without a hit, fetches, and keeps the response there when `keep`. */
async function cacheFirst(request: Request, cacheName: string, keep: boolean): Promise<Response> {
  const cache = await caches.open(cacheName);
  // vite preview sends `Vary: Origin`, and module scripts ask with an Origin the install's requests had not.
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (keep && response.ok) await cache.put(request, response.clone());
  return response;
}

async function shell(request: Request): Promise<Response> {
  return (await caches.match(urlOf('index.html'), { cacheName: CACHE })) ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(scope)) return;
  if (request.mode === 'navigate') event.respondWith(shell(request));
  else if (precached.has(request.url)) event.respondWith(cacheFirst(request, CACHE, false));
  else if (request.url.startsWith(FONTS)) event.respondWith(cacheFirst(request, FONT_CACHE, true));
});
