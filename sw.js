// ── Service worker: offline support for the hosted (GitHub Pages) app ──
//
// Precaches the whole app shell on install, so navigating to the site URL
// works with no connection at all. Every path below is RELATIVE to the
// service worker's own location, so this file works unchanged whatever
// subpath GitHub Pages serves the repo from (e.g. /flysight-insights/).
//
// > **Bump CACHE_VERSION whenever any precached file changes**, to the same
// > value as APP_BUILD in scripts/state.js and the app-build meta tag in
// > index.html, and add new app scripts to PRECACHE. There's no build step to
// > do it automatically. Old caches are deleted on activate.
//
// Strategies:
//   - same-origin GETs (the page and every script, style and image) ->
//     network-first, revalidated past the HTTP cache, falling back to the
//     cache when offline or when the network takes longer than
//     NETWORK_TIMEOUT_MS. Online, the page and its scripts therefore always
//     come from the same release. (Scripts used to be served cache-first,
//     which after a deploy paired the new index.html with the old scripts
//     and broke the page until a hard refresh.)
//   - cross-origin (map tiles) -> not intercepted at all; scripts/tiles.js
//     already caches those as Blobs in IndexedDB
//
// vendor/ffmpeg/ holds only the small scripts (~120 KB); the 30.7 MB H.265
// converter core is fetched from jsDelivr by scripts/convert.js, pinned by an
// SRI hash. Being cross-origin it is not intercepted here either, and the CDN
// serves it immutable, so the browser cache keeps it between sessions.

const CACHE_VERSION = 'flysight-v62';

// A connection that is up but barely working (a weak signal at the drop zone)
// would otherwise keep the app waiting; after this long the cache answers.
const NETWORK_TIMEOUT_MS = 3000;

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
  'scripts/wind.js',
  'scripts/analysis.js',
  'scripts/tiles.js',
  'scripts/notes.js',
  'scripts/zip.js',
  'scripts/widgets/info.js',
  'scripts/widgets/score.js',
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
  'scripts/season.js',
  'scripts/share.js',
  // Loaded by season.js as a Web Worker, not by index.html
  'scripts/analysis-worker.js',
  'scripts/main.js',
  'scripts/whats-new.js',
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

  event.respondWith(networkFirst(req));
});

// Network first, revalidating past the HTTP cache (GitHub Pages lets the
// browser keep files for 10 minutes, long enough to pair a fresh page with
// stale scripts). The cache answers when the network fails or is too slow.
async function networkFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  // A navigation request can't carry a RequestInit, so refetch it by URL.
  // redirect: 'manual' hands a redirect back to the browser to follow, as a
  // navigation does natively; a followed one can't answer a navigation.
  const netReq = req.mode === 'navigate'
    ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' })
    : new Request(req, { cache: 'no-cache' });
  const network = fetch(netReq).then(res => {
    if (res && res.ok && res.status === 200) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  network.catch(() => {}); // may settle after the cache has answered
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, NETWORK_TIMEOUT_MS, null); });
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch {
    // offline: fall through to the cache
  } finally {
    clearTimeout(timer);
  }
  const hit = (await cache.match(req)) ||
    (req.mode === 'navigate' && ((await cache.match(new URL('index.html', self.registration.scope).href)) ||
                                 (await cache.match(new URL('./', self.registration.scope).href))));
  if (hit) return hit;
  // Nothing cached: keep waiting on a slow network rather than give up.
  try {
    const res = await network;
    if (res) return res;
  } catch {}
  return req.mode === 'navigate'
    ? new Response('Offline and this page was never cached.', { status: 503, headers: { 'Content-Type': 'text/plain' } })
    : new Response('', { status: 504, statusText: 'Offline' });
}
