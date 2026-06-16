// ── Storage helpers ──
// Jumps are persisted in IndexedDB (one row per jump, keyed by name).
// On first load after upgrading from the old localStorage backend, any
// existing `flysight_jumps` blob is migrated over and then cleared.
const DB_NAME = 'flysight';
const DB_VERSION = 2;
const STORE_JUMPS = 'jumps';
const STORE_SETTINGS = 'settings';
const LEGACY_KEY = 'flysight_jumps';
const SETTING_WIDGET_LAYOUT = 'widgetLayout';

let _dbPromise = null;

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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

async function storeJump(name, csvText) {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_JUMPS, 'readwrite');
    const store = tx.objectStore(STORE_JUMPS);
    const getReq = store.get(name);
    getReq.onsuccess = () => {
      const addedAt = (getReq.result && getReq.result.addedAt) || Date.now();
      store.put({ name, csv: csvText, addedAt });
    };
    tx.oncomplete = () => resolve();
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

async function removeJump(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_JUMPS, 'readwrite');
    tx.objectStore(STORE_JUMPS).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
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
    const tx = db.transaction(STORE_JUMPS, 'readwrite');
    const store = tx.objectStore(STORE_JUMPS);
    const getReq = store.get(oldName);
    let found = false;
    getReq.onsuccess = () => {
      const row = getReq.result;
      if (!row) return; // tx will still complete; resolve(false) below
      found = true;
      store.put({ name: newName, csv: row.csv, addedAt: row.addedAt || Date.now() });
      store.delete(oldName);
    };
    tx.oncomplete = () => resolve(found);
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
