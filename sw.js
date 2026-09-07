// ── Service worker: offline support for the hosted (GitHub Pages) app ──
//
// Precaches the whole app shell on install, so navigating to the site URL
// works with no connection at all. Every path below is RELATIVE to the
// service worker's own location, so this file works unchanged whatever
// subpath GitHub Pages serves the repo from (e.g. /flysight-insights/).
//
// > **Bump CACHE_VERSION whenever any precached file changes**, and add new
// > app scripts to PRECACHE. There's no build step to do it automatically.
// > Old caches are deleted on activate.
//
// Strategies:
//   - navigations / HTML  -> network-first, falling back to the cached shell
//     (so an online visit always gets the latest app, and an offline one
//     still boots)
//   - other same-origin GETs -> cache-first with a background refresh
//     (stale-while-revalidate): instant offline, updates land next load
//   - cross-origin (map tiles) -> not intercepted at all; scripts/tiles.js
//     already caches those as Blobs in IndexedDB
//
// vendor/ffmpeg/ holds only the small scripts (~120 KB); the 30.7 MB H.265
// converter core is fetched from jsDelivr by scripts/convert.js, pinned by an
// SRI hash. Being cross-origin it is not intercepted here either, and the CDN
// serves it immutable, so the browser cache keeps it between sessions.

const CACHE_VERSION = 'flysight-v7';

const PRECACHE = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icons/icon.svg',

  // Vendored libraries
  'vendor/papaparse.min.js',
  'vendor/chart.umd.min.js',
  'vendor/chartjs-plugin-annotation.min.js',
  'vendor/hammer.min.js',
  'vendor/chartjs-plugin-zoom.min.js',
  'vendor/leaflet.min.css',
  'vendor/leaflet.min.js',
  'vendor/ffmpeg/ffmpeg.js',
  'vendor/ffmpeg/814.ffmpeg.js',
  'vendor/ffmpeg/ffmpeg-core.js',
  'vendor/mp4-muxer.min.js',
  'vendor/webm-muxer.min.js',
  'vendor/images/layers.png',
  'vendor/images/layers-2x.png',
  'vendor/images/marker-icon.png',
  'vendor/images/marker-icon-2x.png',
  'vendor/images/marker-shadow.png',

  // App scripts, in load order
  'scripts/state.js',
  'scripts/theme.js',
  'scripts/translations.js',
  'scripts/i18n.js',
  'scripts/storage.js',
  'scripts/csv.js',
  'scripts/tiles.js',
  'scripts/widgets/info.js',
  'scripts/widgets/speed.js',
  'scripts/widgets/alt-graph.js',
  'scripts/widgets/altimeter.js',
  'scripts/widgets/speed-graph.js',
  'scripts/widgets/mini-map.js',
  'scripts/widgets/g-force.js',
  'scripts/widgets/image.js',
  'scripts/widgets/core.js',
  'scripts/chart.js',
  'scripts/convert.js',
  'scripts/video.js',
  'scripts/compare.js',
  'scripts/main.js',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Add one at a time rather than cache.addAll(), which rejects the whole
    // install if a single file 404s. A missing optional asset shouldn't stop
    // the app from working offline.
    await Promise.all(PRECACHE.map(async path => {
      const url = new URL(path, self.registration.scope).href;
      try {
        // cache: 'reload' bypasses the HTTP cache so an install always
        // captures fresh copies.
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] precache failed:', path, err);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => (n === CACHE_VERSION ? null : caches.delete(n))));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Cross-origin requests (map tiles) are left alone: tiles.js caches those
  // in IndexedDB, and double-caching them would waste quota.
  if (url.origin !== self.location.origin) return;
  // Anything outside this deployment's scope isn't ours to serve.
  if (!url.href.startsWith(new URL('./', self.registration.scope).href)) return;

  // Navigations: network-first so an online load always gets the latest
  // index.html, with the cached shell as the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match(req)) ||
               (await cache.match(new URL('index.html', self.registration.scope).href)) ||
               (await cache.match(new URL('./', self.registration.scope).href)) ||
               new Response('Offline and this page was never cached.', {
                 status: 503,
                 headers: { 'Content-Type': 'text/plain' },
               });
      }
    })());
    return;
  }

  // Everything else: serve from cache immediately, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const hit = await cache.match(req);
    const network = fetch(req)
      .then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);

    if (hit) {
      event.waitUntil(network);   // revalidate without blocking the response
      return hit;
    }
    const fresh = await network;
    return fresh || new Response('', { status: 504, statusText: 'Offline' });
  })());
});
