// ── Storage helpers ──
// Jumps are persisted in IndexedDB (one row per jump, keyed by name).
// On first load after upgrading from the old localStorage backend, any
// existing `flysight_jumps` blob is migrated over and then cleared.
const DB_NAME = 'flysight';
const DB_VERSION = 4;
const STORE_JUMPS = 'jumps';
// One small row per jump (the jump index, see below), so a page load never
// has to read the CSVs to list them.
const STORE_META = 'jumpMeta';
const STORE_SETTINGS = 'settings';
const LEGACY_KEY = 'flysight_jumps';
const SETTING_WIDGET_LAYOUT = 'widgetLayout';

let _dbPromise = null;
let _dbBlockedWarned = false;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_JUMPS)) {
        db.createObjectStore(STORE_JUMPS, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
      // Offline map-tile cache (see scripts/tiles.js). Keyed by tile URL,
      // with an `at` index so the oldest tiles can be pruned first.
      if (!db.objectStoreNames.contains('tiles')) {
        const tiles = db.createObjectStore('tiles', { keyPath: 'key' });
        tiles.createIndex('at', 'at');
      }
      // Starts empty on an upgrade: getJumpIndex() fills it on first use.
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Don't hold an old version open and block another tab's upgrade.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // Another tab has the database open at an older version, so the upgrade
    // can't run. Without this the open request never settles and every
    // storage call hangs silently — tell the user what to do instead.
    req.onblocked = () => {
      if (_dbBlockedWarned) return;
      _dbBlockedWarned = true;
      alert(t('alert.dbBlocked'));
    };
  }).then(async db => {
    await migrateFromLocalStorage(db);
    return db;
  });
  return _dbPromise;
}

function migrateFromLocalStorage(db) {
  return new Promise(resolve => {
    let raw;
    try { raw = localStorage.getItem(LEGACY_KEY); } catch { raw = null; }
    if (!raw) return resolve();
    let legacy;
    try { legacy = JSON.parse(raw); } catch { return resolve(); }
    if (!Array.isArray(legacy) || legacy.length === 0) {
      try { localStorage.removeItem(LEGACY_KEY); } catch {}
      return resolve();
    }
    const tx = db.transaction(STORE_JUMPS, 'readwrite');
    const store = tx.objectStore(STORE_JUMPS);
    legacy.forEach(j => {
      if (j && j.name) store.put({ name: j.name, csv: j.csv, addedAt: j.addedAt || Date.now() });
    });
    tx.oncomplete = () => {
      try { localStorage.removeItem(LEGACY_KEY); } catch {}
      resolve();
    };
    tx.onerror = () => resolve(); // keep legacy data in localStorage on failure
  });
}

async function getStoredJumps() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_JUMPS, 'readonly');
    const req = tx.objectStore(STORE_JUMPS).getAll();
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

// One jump's row ({ name, csv, addedAt }), or null. Reads that row only, so
// opening a jump costs the same however many are stored.
async function getJump(name) {
  if (name == null) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_JUMPS, 'readonly').objectStore(STORE_JUMPS).get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// ── Jump index ──
// The jump list, the rename check and the undo only need each jump's name,
// upload time and flight date, never its CSV. getStoredJumps() copies every
// CSV out of IndexedDB, hundreds of MB with a season stored, so those callers
// read this index instead. It is persisted in the `jumpMeta` store, one row
// per jump written in the same transaction as the jump itself, so a page load
// reads a few KB instead of every CSV. Entries are
// { name, addedAt, flightDate, csvKey }, flightDate from main.js's
// jumpFlightDate() (called at run time, after main.js loaded).
// Bump META_VERSION when jumpFlightDate() or csvQuickKey() changes what they
// return: rows written under an older version are recomputed from their CSV.
const META_VERSION = 1;
let _jumpIndex = null;        // Map name -> entry, once loaded
let _jumpIndexBuild = null;   // the load in flight
let _jumpIndexGen = 0;        // bumped by every write, so a load that raced one is redone

// Another tab's import or delete leaves this tab's index stale: drop it, and
// the next read reloads it (from jumpMeta, which that tab kept current).
let _jumpChannel = null;
try {
  _jumpChannel = new BroadcastChannel('flysight-jumps');
  _jumpChannel.onmessage = () => { _jumpIndexGen++; _jumpIndex = null; };
} catch (e) {}

function jumpIndexEntry(row) {
  return { name: row.name, addedAt: row.addedAt, flightDate: jumpFlightDate(row.csv), csvKey: csvQuickKey(row.csv) };
}

// The jumpMeta row for an index entry: the entry plus the version it was
// computed under.
function jumpMetaRow(entry) {
  return { ...entry, v: META_VERSION };
}

// A cheap stand-in for the CSV's content: its length plus FNV-1a over the
// first and last 64K characters. Enough to notice a re-upload under the same
// name, which changes the recording and so its start, end or length. Lets the
// season view check its cache from the index without reading any CSV.
const CSV_KEY_SPAN = 65536;
function csvQuickKey(csv) {
  let h = 0x811c9dc5;
  const mix = (from, to) => {
    for (let i = from; i < to; i++) { h ^= csv.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  };
  if (csv.length <= 2 * CSV_KEY_SPAN) mix(0, csv.length);
  else { mix(0, CSV_KEY_SPAN); mix(csv.length - CSV_KEY_SPAN, csv.length); }
  return csv.length + ':' + (h >>> 0).toString(16);
}

// The stored jump names (keys only, no CSV) and every jumpMeta row, read in
// one transaction so the two agree.
function readJumpMeta(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_JUMPS, STORE_META], 'readonly');
    let names = [], rows = [];
    const keysReq = tx.objectStore(STORE_JUMPS).getAllKeys();
    keysReq.onsuccess = () => { names = keysReq.result || []; };
    const metaReq = tx.objectStore(STORE_META).getAll();
    metaReq.onsuccess = () => { rows = metaReq.result || []; };
    tx.oncomplete = () => resolve({ names, rows });
    tx.onerror = () => reject(tx.error);
  });
}

// Index entries for jumps whose meta row is missing or outdated: every jump on
// the first load after this store was added, a jump written by an older
// release in another tab, or all of them after a META_VERSION bump. One get()
// at a time, chained, so only one CSV is held in memory.
function computeJumpEntries(db, names) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const store = db.transaction(STORE_JUMPS, 'readonly').objectStore(STORE_JUMPS);
    let i = 0;
    const next = () => {
      if (i >= names.length) return;
      const req = store.get(names[i++]);
      req.onsuccess = () => {
        if (req.result) entries.push(jumpIndexEntry(req.result));
        next();
      };
    };
    next();
    store.transaction.oncomplete = () => resolve(entries);
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

// Bring jumpMeta in line with the jumps store: write the recomputed rows and
// drop rows whose jump is gone. A failure is not fatal: the index in memory is
// still right, and the next load repairs again.
function repairJumpMeta(db, entries, orphans) {
  return new Promise(resolve => {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    entries.forEach(e => store.put(jumpMetaRow(e)));
    orphans.forEach(name => store.delete(name));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function readJumpIndex(db) {
  const { names, rows } = await readJumpMeta(db);
  const map = new Map();
  const meta = new Map(rows.map(r => [r.name, r]));
  const stale = [];
  names.forEach(name => {
    const r = meta.get(name);
    if (r && r.v === META_VERSION) {
      map.set(name, { name: r.name, addedAt: r.addedAt, flightDate: r.flightDate, csvKey: r.csvKey });
    } else {
      stale.push(name);
    }
  });
  const known = new Set(names);
  const orphans = rows.filter(r => !known.has(r.name)).map(r => r.name);
  if (stale.length || orphans.length) {
    const entries = stale.length ? await computeJumpEntries(db, stale) : [];
    entries.forEach(e => map.set(e.name, e));
    await repairJumpMeta(db, entries, orphans);
  }
  return map;
}

async function buildJumpIndex() {
  const db = await openDB();
  for (;;) {
    const gen = _jumpIndexGen;
    const map = await readJumpIndex(db);
    if (gen === _jumpIndexGen) { _jumpIndex = map; return; }
  }
}

// Every stored jump as { name, addedAt, flightDate, csvKey }, oldest upload
// first (the same order as getStoredJumps()).
async function getJumpIndex() {
  while (!_jumpIndex) {
    if (!_jumpIndexBuild) _jumpIndexBuild = buildJumpIndex().finally(() => { _jumpIndexBuild = null; });
    await _jumpIndexBuild;
  }
  return Array.from(_jumpIndex.values(), e => ({ ...e }))
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

// Called by each write once its transaction has committed. The write put the
// jumpMeta rows in that same transaction; this keeps the copy in memory current.
function updateJumpIndex(apply) {
  _jumpIndexGen++;
  if (_jumpIndex) apply(_jumpIndex);
  if (_jumpChannel) { try { _jumpChannel.postMessage('changed'); } catch (e) {} }
}

async function storeJump(name, csvText) {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction([STORE_JUMPS, STORE_META], 'readwrite');
    const store = tx.objectStore(STORE_JUMPS);
    const getReq = store.get(name);
    let entry = null;
    getReq.onsuccess = () => {
      const addedAt = (getReq.result && getReq.result.addedAt) || Date.now();
      store.put({ name, csv: csvText, addedAt });
      entry = jumpIndexEntry({ name, csv: csvText, addedAt });
      tx.objectStore(STORE_META).put(jumpMetaRow(entry));
    };
    tx.oncomplete = () => {
      updateJumpIndex(m => m.set(name, entry));
      resolve();
    };
    tx.onerror = () => {
      alert(t('alert.storageFull'));
      resolve();
    };
    tx.onabort = () => {
      alert(t('alert.storageFull'));
      resolve();
    };
  });
}

// Delete several jumps in one transaction and resolve with the rows that were
// actually removed ({ name, csv, addedAt }), so the caller can offer an undo.
async function removeJumps(names) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_JUMPS, STORE_META], 'readwrite');
    const store = tx.objectStore(STORE_JUMPS);
    const meta = tx.objectStore(STORE_META);
    const removed = [];
    names.forEach(name => {
      const getReq = store.get(name);
      getReq.onsuccess = () => {
        if (!getReq.result) return;
        removed.push(getReq.result);
        store.delete(name);
        meta.delete(name);
      };
    });
    tx.oncomplete = () => {
      updateJumpIndex(m => removed.forEach(row => m.delete(row.name)));
      resolve(removed);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Put rows removed by removeJumps() back exactly as they were, addedAt included,
// so an undone delete lands in the same place in the list.
async function restoreJumps(rows) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_JUMPS, STORE_META], 'readwrite');
    const store = tx.objectStore(STORE_JUMPS);
    const meta = tx.objectStore(STORE_META);
    const put = rows.map(row => ({ name: row.name, csv: row.csv, addedAt: row.addedAt || Date.now() }));
    const entries = put.map(jumpIndexEntry);
    put.forEach(row => store.put(row));
    entries.forEach(e => meta.put(jumpMetaRow(e)));
    tx.oncomplete = () => {
      updateJumpIndex(m => entries.forEach(e => m.set(e.name, e)));
      resolve();
    };
    tx.onerror = () => {
      alert(t('alert.storageFull'));
      reject(tx.error);
    };
    tx.onabort = () => reject(tx.error);
  });
}

// Rename a stored jump. `name` is the keyPath, so this re-keys the row:
// read the old row, write a new row under `newName` (preserving csv + addedAt),
// then delete the old one — all in a single transaction so it's atomic.
// Resolves true on success, false if the old jump no longer exists.
async function renameJump(oldName, newName) {
  if (oldName === newName) return true;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_JUMPS, STORE_META], 'readwrite');
    const store = tx.objectStore(STORE_JUMPS);
    const meta = tx.objectStore(STORE_META);
    const getReq = store.get(oldName);
    let entry = null;
    getReq.onsuccess = () => {
      const row = getReq.result;
      if (!row) return; // tx will still complete; resolve(false) below
      const renamed = { name: newName, csv: row.csv, addedAt: row.addedAt || Date.now() };
      store.put(renamed);
      store.delete(oldName);
      entry = jumpIndexEntry(renamed);
      meta.put(jumpMetaRow(entry));
      meta.delete(oldName);
    };
    tx.oncomplete = () => {
      if (entry) {
        updateJumpIndex(m => {
          m.delete(oldName);
          m.set(newName, entry);
        });
      }
      resolve(!!entry);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ── Settings store: generic key/value ──
async function getSetting(key) {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const req = tx.objectStore(STORE_SETTINGS).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => resolve(null);
  });
}

async function setSetting(key, value) {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    tx.objectStore(STORE_SETTINGS).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

// ── Widget layout persistence ──
// Stores the user's last-used video-overlay widget configuration so it can be
// restored automatically the next time any video is loaded.
async function loadWidgetLayout() {
  try {
    const v = await getSetting(SETTING_WIDGET_LAYOUT);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function saveWidgetLayout() {
  try {
    const serialized = (state.widgets || []).map(w => ({
      id: w.id,
      type: w.type,
      x: w.x,
      y: w.y,
      widgetScale: w.widgetScale,
      config: { ...w.config },
    }));
    await setSetting(SETTING_WIDGET_LAYOUT, serialized);
  } catch {
    // Swallow — layout persistence failures are non-fatal.
  }
}
