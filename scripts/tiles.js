// ── Offline map tiles ──
// Satellite tiles are the only part of the app that still needs the network.
// Every tile that has ever been displayed is cached as a Blob in IndexedDB
// (store `tiles`), and the cache is read *before* the network — so once a
// drop zone has been viewed online, the same view keeps working offline.
//
// `CachedTileLayer` is a drop-in replacement for `L.tileLayer(...)`:
//   cachedTileLayer(url, opts)  ->  L.TileLayer with cache-first loading
// `loadCachedTileImage(url)` is the same cache for the compare view's 3D
// ground texture, which builds its own tile mosaic outside Leaflet.

const STORE_TILES = 'tiles';
const TILE_CACHE_MAX = 4000;      // ~30 kB/tile -> a ~120 MB ceiling
const TILE_PRUNE_EVERY = 200;     // check the count every N writes

const TILE_MEM_MAX = 512;         // in-memory LRU of blob URLs, ~15 MB

let _tileWrites = 0;
let _tilePruning = false;

function tileKey(url) {
  return url;
}

// ── In-memory layer ──
// Leaflet throws away a zoom level's <img>s as soon as you leave it, so going
// back used to cost an IndexedDB read, a fresh blob URL and a decode per tile.
// Recently shown tiles keep their blob URL here instead, which lets the
// browser reuse the already-decoded image and the tile appear synchronously.
// Map iteration order is insertion order, so re-inserting on a hit makes the
// first key the least recently used.
const _tileMem = new Map();

function memGetTile(url) {
  const objectUrl = _tileMem.get(url);
  if (!objectUrl) return null;
  _tileMem.delete(url);
  _tileMem.set(url, objectUrl);
  return objectUrl;
}

function memPutTile(url, blob) {
  const existing = memGetTile(url);
  if (existing) return existing;
  const objectUrl = URL.createObjectURL(blob);
  _tileMem.set(url, objectUrl);
  if (_tileMem.size > TILE_MEM_MAX) {
    const [oldUrl, oldObjectUrl] = _tileMem.entries().next().value;
    _tileMem.delete(oldUrl);
    // A tile already on screen keeps its decoded pixels after a revoke.
    URL.revokeObjectURL(oldObjectUrl);
  }
  return objectUrl;
}

function memDropTile(url) {
  const objectUrl = _tileMem.get(url);
  if (!objectUrl) return;
  _tileMem.delete(url);
  URL.revokeObjectURL(objectUrl);
}

async function getCachedTile(url) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_TILES)) return null;
    return await new Promise(resolve => {
      const tx = db.transaction(STORE_TILES, 'readonly');
      const req = tx.objectStore(STORE_TILES).get(tileKey(url));
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function putCachedTile(url, blob) {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_TILES)) return;
    await new Promise(resolve => {
      const tx = db.transaction(STORE_TILES, 'readwrite');
      tx.objectStore(STORE_TILES).put({ key: tileKey(url), blob, at: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();   // a full quota just means no caching
      tx.onabort = () => resolve();
    });
    if (++_tileWrites % TILE_PRUNE_EVERY === 0) pruneTileCache();
  } catch {
    // Non-fatal: the tile still displays, it just isn't cached.
  }
}

// Drop the oldest tiles once the store grows past TILE_CACHE_MAX, so the
// cache can't grow without bound over a season of jumps.
async function pruneTileCache() {
  if (_tilePruning) return;
  _tilePruning = true;
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_TILES)) return;
    const count = await new Promise(resolve => {
      const tx = db.transaction(STORE_TILES, 'readonly');
      const req = tx.objectStore(STORE_TILES).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
    if (count <= TILE_CACHE_MAX) return;
    let toDelete = count - Math.floor(TILE_CACHE_MAX * 0.8);
    await new Promise(resolve => {
      const tx = db.transaction(STORE_TILES, 'readwrite');
      const req = tx.objectStore(STORE_TILES).index('at').openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || toDelete <= 0) return;
        cur.delete();
        toDelete--;
        cur.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    // ignore
  } finally {
    _tilePruning = false;
  }
}

async function clearTileCache() {
  const db = await openDB();
  if (!db.objectStoreNames.contains(STORE_TILES)) return;
  return new Promise(resolve => {
    const tx = db.transaction(STORE_TILES, 'readwrite');
    tx.objectStore(STORE_TILES).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

// Number of cached tiles + their total size in bytes (for the storage note).
async function tileCacheStats() {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_TILES)) return { count: 0, bytes: 0 };
    return await new Promise(resolve => {
      const tx = db.transaction(STORE_TILES, 'readonly');
      const req = tx.objectStore(STORE_TILES).openCursor();
      let count = 0, bytes = 0;
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        count++;
        bytes += (cur.value.blob && cur.value.blob.size) || 0;
        cur.continue();
      };
      tx.oncomplete = () => resolve({ count, bytes });
      tx.onerror = () => resolve({ count, bytes });
    });
  } catch {
    return { count: 0, bytes: 0 };
  }
}

// ── Leaflet layer ──
// Cache-first `createTile`: memory -> cached Blob -> network fetch (cached on
// success) -> plain <img src> as a last resort. The final fallback matters
// because a fetch() can fail on CORS grounds where a plain <img> would still
// render; that path simply doesn't populate the cache.
const CachedTileLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('img');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');

    const url = this.getTileUrl(coords);
    let fromMem = false;

    L.DomEvent.on(tile, 'load', () => done(null, tile));
    L.DomEvent.on(tile, 'error', () => {
      // A blob URL that fails to load is useless to keep around.
      if (fromMem) memDropTile(url);
      if (!navigator.onLine) setMapTilesOffline(true);
      done(new Error('tile load failed'), tile);
    });

    const showBlob = blob => { fromMem = true; tile.src = memPutTile(url, blob); };
    const showDirect = () => { fromMem = false; tile.src = url; };

    const memUrl = memGetTile(url);
    if (memUrl) {
      fromMem = true;
      tile._fromCache = true;
      tile.src = memUrl;
      return tile;
    }

    getCachedTile(url).then(blob => {
      if (blob) {
        tile._fromCache = true;
        return showBlob(blob);
      }
      if (!navigator.onLine) {
        // Offline with nothing cached for this tile: fail fast rather than
        // waiting on a network request that can't succeed.
        setMapTilesOffline(true);
        done(new Error('offline'), tile);
        return;
      }
      return fetch(url, { mode: 'cors', credentials: 'omit' })
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.blob();
        })
        .then(blob => {
          putCachedTile(url, blob);
          showBlob(blob);
        })
        .catch(() => showDirect());
    }).catch(() => showDirect());

    return tile;
  },

  // Leaflet fades every tile in over 200 ms. That reads as "loading" for a
  // tile that came out of the cache, so those are shown at full opacity
  // straight away; only freshly downloaded tiles still fade in. Backdating
  // `loaded` makes Leaflet's next _updateOpacity pass see the fade as done,
  // so pruning of the tiles underneath still happens on its normal path.
  _tileReady(coords, err, tile) {
    L.TileLayer.prototype._tileReady.call(this, coords, err, tile);
    if (err || !tile || !tile._fromCache || !this._tiles) return;
    const entry = this._tiles[this._tileCoordsToKey(coords)];
    if (!entry) return;
    entry.loaded = 1;
    L.DomUtil.setOpacity(entry.el, 1);
  },
});

function cachedTileLayer(url, opts) {
  return new CachedTileLayer(url, opts);
}

// Load a single tile as an <img> through the cache, for the compare view's
// 3D ground texture. Resolves null when the tile is unavailable (offline and
// uncached), which leaves a blank patch in the mosaic.
function loadCachedTileImage(url) {
  const decode = (src, objectUrl) => new Promise(resolve => {
    const img = new Image();
    if (!objectUrl) img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    img.src = src;
  });

  return getCachedTile(url).then(blob => {
    if (blob) {
      const objectUrl = URL.createObjectURL(blob);
      return decode(objectUrl, objectUrl);
    }
    if (!navigator.onLine) {
      setMapTilesOffline(true);
      return null;
    }
    return fetch(url, { mode: 'cors', credentials: 'omit' })
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(b => {
        putCachedTile(url, b);
        const objectUrl = URL.createObjectURL(b);
        return decode(objectUrl, objectUrl);
      })
      .catch(() => decode(url, null));
  }).catch(() => decode(url, null));
}

// ── "tiles unavailable" notice ──
// Shown over the map (and the compare map) when we're offline and a tile
// wasn't in the cache. Cleared as soon as the browser reports it's online
// again, and on every map rebuild.
function setMapTilesOffline(on) {
  state.mapTilesOffline = !!on;
  document.querySelectorAll('.map-offline-note').forEach(el => {
    el.hidden = !on;
  });
}

// Going offline doesn't hide anything that's already drawn — the note only
// appears once a tile actually misses the cache. Coming back online clears it.
window.addEventListener('online', () => setMapTilesOffline(false));
