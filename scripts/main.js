
// ── File handling ──
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  // The window-level drop handler below must not import the same files again.
  e.stopPropagation();
  dropzone.classList.remove('dragover');
  handleDrop(e.dataTransfer);
});
fileInput.addEventListener('change', e => handleFiles(e.target.files));

// ── Folder import ──
// A dropped folder shows up in dataTransfer.files as one empty, unreadable
// entry, so folders are read through the entry API instead. The entries must
// be taken synchronously inside the drop event: dataTransfer is emptied as
// soon as the handler yields.
function handleDrop(dataTransfer) {
  const entries = droppedEntriesWithFolder(dataTransfer);
  if (!entries) {
    handleFiles(dataTransfer.files);
    return;
  }
  filesFromEntries(entries).then(files => handleFiles(files, { folder: true }));
}

// The drop's entries when at least one of them is a folder, else null (a plain
// file drop keeps its existing path).
function droppedEntriesWithFolder(dataTransfer) {
  const items = dataTransfer && dataTransfer.items;
  if (!items || !items.length) return null;
  const entries = [];
  let hasFolder = false;
  for (const item of items) {
    if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
    const entry = item.webkitGetAsEntry();
    if (!entry) continue;
    if (entry.isDirectory) hasFolder = true;
    entries.push(entry);
  }
  return hasFolder ? entries : null;
}

// Hidden files and folders: dotfiles, and the "._TRACK.CSV" resource-fork
// copies macOS writes next to every file on a FAT-formatted SD card.
function isHiddenName(name) {
  return name.charAt(0) === '.';
}

// Walk the dropped entries recursively and collect every CSV file. Anything
// else on the card (CONFIG.TXT, RAW.UBX, videos) is not even opened.
// readEntries() returns a folder's children in batches, so it is called until
// it comes back empty. An unreadable entry is skipped, not fatal.
async function filesFromEntries(entries) {
  const files = [];
  async function walk(entry) {
    if (isHiddenName(entry.name)) return;
    try {
      if (entry.isFile) {
        if (/\.csv$/i.test(entry.name)) files.push(await new Promise((res, rej) => entry.file(res, rej)));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const child of batch) await walk(child);
        }
      }
    } catch (e) {
      console.warn('Folder import: could not read', entry.fullPath, e);
    }
  }
  for (const entry of entries) await walk(entry);
  return files;
}

// ── Page-wide drop target ──
// When the user drags a file anywhere on the page, surface a full-viewport
// drop zone so they don't have to scroll back to the small dropzone after a
// jump is loaded. While the video overlay modal is open AND awaiting a video
// (step 1), we drive a separate full-page overlay that loads the video instead.
const pageDropOverlay = document.getElementById('pageDropOverlay');
const videoPageDropOverlay = document.getElementById('videoPageDropOverlay');
let dragDepth = 0;
let videoDragDepth = 0;

function isFileDrag(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}
function isVideoModalOpen() {
  return document.getElementById('videoModal').classList.contains('open');
}
function isVideoModalAwaitingDrop() {
  return isVideoModalOpen() &&
         document.getElementById('videoStep1').style.display !== 'none';
}
function clearVideoPageDropOverlay() {
  videoDragDepth = 0;
  videoPageDropOverlay.classList.remove('active');
}
function isCsvDrag(e) {
  if (!e.dataTransfer) return false;
  const items = e.dataTransfer.items;
  // Some browsers (Safari, older Firefox) don't expose item types during drag —
  // allow optimistically so we don't break the common case.
  if (!items || !items.length) return true;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const t = (item.type || '').toLowerCase();
    // Empty type = unknown extension, likely CSV. text/csv is explicit.
    if (!t || t === 'text/csv' || t === 'application/vnd.ms-excel') return true;
  }
  return false;
}

window.addEventListener('dragenter', e => {
  if (!isFileDrag(e)) return;
  if (isVideoModalAwaitingDrop()) {
    videoDragDepth++;
    videoPageDropOverlay.classList.add('active');
    return;
  }
  if (isVideoModalOpen() || !isCsvDrag(e)) return;
  dragDepth++;
  pageDropOverlay.classList.add('active');
});
window.addEventListener('dragover', e => {
  if (!isFileDrag(e)) return;
  if (isVideoModalAwaitingDrop()) { e.preventDefault(); return; }
  if (isVideoModalOpen() || !isCsvDrag(e)) return;
  e.preventDefault(); // required so 'drop' fires
});
window.addEventListener('dragleave', e => {
  if (!isFileDrag(e)) return;
  if (isVideoModalAwaitingDrop()) {
    videoDragDepth = Math.max(0, videoDragDepth - 1);
    if (videoDragDepth === 0) videoPageDropOverlay.classList.remove('active');
    return;
  }
  if (isVideoModalOpen() || !isCsvDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) pageDropOverlay.classList.remove('active');
});
window.addEventListener('drop', e => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  if (isVideoModalAwaitingDrop()) {
    e.preventDefault();
    clearVideoPageDropOverlay();
    handleVideoFile(e.dataTransfer.files[0]);
    return;
  }
  if (isVideoModalOpen()) return;
  e.preventDefault();
  dragDepth = 0;
  pageDropOverlay.classList.remove('active');
  handleDrop(e.dataTransfer);
});

function isCsvFile(file) {
  return /\.csv$/i.test(file.name);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// Yield to the browser so any pending DOM mutations actually paint before
// we start CPU-heavy CSV parsing (otherwise the loading spinner never shows).
function nextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

// ── Upload naming ──
// A jump is keyed by its filename, and a duplicate name deliberately
// overwrites (that's how re-uploading a corrected file works). FlySight 2
// breaks that assumption: it writes every recording to a fixed filename
// inside a per-jump folder (/<date>/<time>/TRACK.CSV), so dropping a season's
// worth of jumps would collapse them all into one "TRACK" chip, each file
// silently overwriting the last. For those generic names the flight's own
// start time is prefixed, which keeps genuinely different jumps apart while
// still letting a re-upload of the same recording overwrite itself.
var GENERIC_JUMP_NAMES = ['track', 'sensor', 'raw'];

function baseJumpName(file) {
  return file.name.replace(/\.csv$/i, '');
}

function isGenericJumpName(name) {
  return GENERIC_JUMP_NAMES.indexOf(name.trim().toLowerCase()) !== -1;
}

// "2026-07-11 09-47" — the recording's own UTC start, from jumpFlightDate().
// Hyphens rather than colons so downloadJump()'s suggested filename stays
// valid on Windows. Minute resolution is enough: a recording spans minutes,
// so two of them can't start in the same one.
function flightStamp(csv) {
  const d = jumpFlightDate(csv);
  if (!d) return null;
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + '-' + p(d.getUTCMinutes());
}

// Storage name for an uploaded file. Generic FlySight 2 filenames get the
// flight start time prefixed; every other name is kept verbatim so the
// existing overwrite-on-re-upload behaviour is untouched. `taken` holds the
// names already claimed by *this* batch (not the stored ones), so two dropped
// files that resolve to the same name can't overwrite each other mid-batch.
function resolveJumpName(base, csv, taken) {
  let name = base;
  if (isGenericJumpName(base)) {
    const stamp = flightStamp(csv);
    // Stamp first, mirroring FlySight 1's own date-then-time file naming, so
    // the chip reads chronologically: "2026-07-11 09-47_TRACK".
    if (stamp) name = stamp + '_' + base;
  }
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(name + ' (' + n + ')')) n++;
  return name + ' (' + n + ')';
}

// Batches at least this large are stored with one counting chip and a list
// refresh every BULK_RENDER_EVERY files: re-rendering the sidebar (which reads
// every stored jump back) after each of 200 files is what made a big import crawl.
const BULK_IMPORT_MIN = 10;
const BULK_RENDER_EVERY = 25;

// A yield that also fires in a background tab, where requestAnimationFrame
// does not (nextPaint() would stall the import until the tab is shown).
function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// `opts.folder`: the files come from a dropped folder (already walked by
// filesFromEntries(), which skips hidden files). Non-CSV files are then skipped
// silently instead of alerted, and CSVs with no GPS timestamps (FlySight 2's
// SENSOR.CSV) are left out.
async function handleFiles(files, opts) {
  const folder = !!(opts && opts.folder);
  const all = Array.from(files);
  const csvFiles = all.filter(isCsvFile);
  const rejected = all.filter(f => !isCsvFile(f));
  if (rejected.length && !folder) {
    alert(t('alert.onlyCsv', { files: rejected.map(f => f.name).join(', ') }));
  }
  if (!csvFiles.length) {
    if (folder) alert(t('alert.noCsvInFolder'));
    return;
  }
  if (folder || csvFiles.length >= BULK_IMPORT_MIN) return importBulk(csvFiles, folder);

  // Register every dropped file as "loading" up front and render the sidebar
  // so the user sees spinner chips immediately — even before FileReader
  // finishes on the first byte. Yield to the browser so the chips paint
  // before we kick off the parse work for the first file.
  // Keyed by the *filename*, since the final jump name isn't known until the
  // CSV has been read (see resolveJumpName). state.loadingJumps is a Set, so a
  // batch of same-named files (every FlySight 2 drop) shares one spinner —
  // pendingPerName counts them down so it isn't cleared while others are still
  // being read.
  const pendingPerName = new Map();
  csvFiles.forEach(file => {
    const base = baseJumpName(file);
    pendingPerName.set(base, (pendingPerName.get(base) || 0) + 1);
    state.loadingJumps.add(base);
  });
  await renderJumpList();
  await nextPaint();

  let lastName = null;
  const takenNames = new Set();
  const storedNames = [];
  for (const file of csvFiles) {
    const base = baseJumpName(file);
    try {
      const csv = await readFileAsText(file);
      const name = resolveJumpName(base, csv, takenNames);
      takenNames.add(name);
      await storeJump(name, csv);
      if (state.compareDataCache) state.compareDataCache.delete(name);
      lastName = name;
      storedNames.push(name);
    } catch (e) {
      // Individual file failures shouldn't block the rest of the batch.
      console.error('Failed to load', file.name, e);
    }
    const stillPending = (pendingPerName.get(base) || 1) - 1;
    pendingPerName.set(base, stillPending);
    if (stillPending <= 0) state.loadingJumps.delete(base);
    await renderJumpList();
    // Yield before the next file's CPU work so this row's spinner clears
    // and any other still-loading rows keep animating smoothly.
    await nextPaint();
  }

  if (lastName) selectJump(lastName);
  if (storedNames.length && typeof warmSeasonCache === 'function') warmSeasonCache(storedNames);
}

// Large batches and folder imports. Same naming as handleFiles(), plus:
//   - a file identical to the stored jump it resolves to is not rewritten, so
//     re-importing a whole SD card only stores what is new or changed;
//   - in folder mode, a CSV without GPS timestamps is skipped;
//   - the newest flight, not the last file read, becomes the open jump;
//   - a folder import ends with a summary toast.
async function importBulk(csvFiles, folder) {
  const storedCsv = new Map((await getStoredJumps()).map(j => [j.name, j.csv]));
  state.importProgress = { done: 0, total: csvFiles.length };
  await renderJumpList();
  await yieldToBrowser();

  const takenNames = new Set();
  const changed = [];
  let unchanged = 0, skipped = 0;
  let newest = null;
  for (const file of csvFiles) {
    try {
      const csv = await readFileAsText(file);
      const date = jumpFlightDate(csv);
      if (folder && !date) {
        skipped++;
      } else {
        const name = resolveJumpName(baseJumpName(file), csv, takenNames);
        takenNames.add(name);
        if (storedCsv.get(name) === csv) {
          unchanged++;
        } else {
          await storeJump(name, csv);
          storedCsv.set(name, csv);
          if (state.compareDataCache) state.compareDataCache.delete(name);
          changed.push(name);
        }
        const ms = date ? date.getTime() : -Infinity;
        if (!newest || ms >= newest.ms) newest = { name, ms };
      }
    } catch (e) {
      console.error('Failed to load', file.name, e);
      skipped++;
    }
    state.importProgress.done++;
    if (state.importProgress.done % BULK_RENDER_EVERY === 0) await renderJumpList();
    else updateImportProgressChip();
    await yieldToBrowser();
  }

  state.importProgress = null;
  // The list was only rebuilt every BULK_RENDER_EVERY files, and selectJump()
  // no longer rebuilds it, so bring it up to date first.
  await renderJumpList();
  if (newest) await selectJump(newest.name);
  if (folder) showImportToast(changed.length, unchanged, skipped);
  // Score the new and changed jumps in the background, so the season view
  // opens without a wait (warmSeasonCache in scripts/season.js).
  if (changed.length && typeof warmSeasonCache === 'function') warmSeasonCache(changed);
}

function importProgressText() {
  const p = state.importProgress;
  return t('import.progress', { done: p.done, total: p.total });
}

// Updates the counting chip in place between full list renders.
function updateImportProgressChip() {
  const label = document.querySelector('#importProgressChip .jump-loading-name');
  if (label && state.importProgress) label.textContent = importProgressText();
}

// ── Import summary toast ──
// Same look and place as the undo toast; sits above it when both are up.
const IMPORT_TOAST_MS = 8000;
let importToastTimer = null;
let importToastCounts = null;

function showImportToast(imported, unchanged, skipped) {
  importToastCounts = { imported, unchanged, skipped };
  refreshImportToastLang();
  const toast = document.getElementById('importToast');
  toast.classList.toggle('stacked', !document.getElementById('undoToast').hidden);
  toast.hidden = false;
  clearTimeout(importToastTimer);
  importToastTimer = setTimeout(hideImportToast, IMPORT_TOAST_MS);
}

function hideImportToast() {
  clearTimeout(importToastTimer);
  importToastCounts = null;
  document.getElementById('importToast').hidden = true;
}

// Called from applyLanguage().
function refreshImportToastLang() {
  if (importToastCounts) document.getElementById('importToastText').textContent = t('import.done', importToastCounts);
}

(function initImportToast() {
  const toast = document.getElementById('importToast');
  document.getElementById('importToastClose').addEventListener('click', hideImportToast);
  toast.addEventListener('mouseenter', () => clearTimeout(importToastTimer));
  toast.addEventListener('mouseleave', () => {
    if (importToastCounts) importToastTimer = setTimeout(hideImportToast, IMPORT_TOAST_MS);
  });
})();

// ── Jump list rendering ──
function makeLoadingChip(name) {
  // Use textContent for the name so quotes / HTML chars in filenames can't
  // break the markup or open an XSS hole.
  const chip = document.createElement('div');
  chip.className = 'jump-chip loading';
  chip.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  const label = document.createElement('span');
  label.className = 'jump-loading-name';
  label.textContent = name;
  chip.appendChild(label);
  return chip;
}

// Extract a jump's flight date from its CSV — the first data row's UTC
// timestamp. Cheap string slicing over the first few lines, no full parse, so
// it works for both layouts without caring how tall the preamble is:
// FlySight 1 has header + units rows, FlySight 2 has a variable-length
// $FLYS/$VAR/$COL/$UNIT/$DATA block and prefixes each sample with `$GNSS,`.
// Returns null if it can't be read.
function jumpFlightDate(csv) {
  if (!csv) return null;
  const MAX_PREAMBLE_LINES = 40;
  let pos = 0;
  for (let n = 0; n < MAX_PREAMBLE_LINES && pos < csv.length; n++) {
    let end = csv.indexOf('\n', pos);
    if (end < 0) end = csv.length;
    const fields = csv.slice(pos, end).split(',');
    // FlySight 1: timestamp in the first field. FlySight 2: in the second,
    // behind the record tag.
    const ts = (fields[0] === '$GNSS' ? fields[1] : fields[0] || '').trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) {
      const d = new Date(ts);
      return isNaN(d.getTime()) ? null : d;
    }
    pos = end + 1;
  }
  return null;
}

// Day bucket key (UTC) used to group consecutive jumps from the same day.
function jumpDayKey(d) {
  return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
}

// "Sun, 14 09 2025" — weekday localized to the active UI language, UTC date parts.
function formatJumpDayHeader(d) {
  let wd;
  const lang = (typeof currentLang !== 'undefined') ? currentLang : 'en';
  try {
    wd = new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(d);
  } catch (e) {
    wd = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(d);
  }
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return wd + ', ' + dd + '-' + mm + '-' + d.getUTCFullYear();
}

// Per-day collapse state for a jump list, persisted in localStorage so a
// collapsed day stays collapsed across reloads. Keyed by jumpDayKey(). The
// storage key is a parameter because the sidebar list and the compare modal's
// list keep independent collapse state (collapsing a day while comparing
// shouldn't disturb the sidebar).
const COLLAPSED_DAYS_KEY = 'flysight_collapsed_days';
function getCollapsedDays(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key || COLLAPSED_DAYS_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
function saveCollapsedDays(set, key) {
  try { localStorage.setItem(key || COLLAPSED_DAYS_KEY, JSON.stringify([...set])); } catch (e) {}
}

// Per-year open/closed choices for the sidebar's year groups, persisted as
// { "2025": true (collapsed) | false (open) }. A year with no choice yet
// follows the default: the newest year open, every older year collapsed.
const COLLAPSED_YEARS_KEY = 'flysight_collapsed_years';
function getCollapsedYears() {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_YEARS_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
function saveCollapsedYears(map) {
  try { localStorage.setItem(COLLAPSED_YEARS_KEY, JSON.stringify(map)); } catch (e) {}
}
function isYearCollapsed(map, year, newestYear) {
  const v = map[year];
  return typeof v === 'boolean' ? v : year !== newestYear;
}

// ── Jump list sorting ──
// The list is always sorted by date; only the direction is user-controlled, via
// the small sort icon in the first day header. The choice persists in a cookie
// (1-year), mirrored to localStorage as a fallback for file:// origins that drop
// cookies — same pattern as theme/lang.
const JUMP_SORTS = ['date-asc', 'date-desc'];
const DEFAULT_JUMP_SORT = 'date-desc';   // newest first

function readJumpSort() {
  let v = null;
  try {
    const m = document.cookie.match(/(?:^|;\s*)flysight_jump_sort=([^;]+)/);
    if (m) v = decodeURIComponent(m[1]);
  } catch (e) {}
  if (v == null) { try { v = localStorage.getItem('flysight_jump_sort'); } catch (e) {} }
  return JUMP_SORTS.indexOf(v) >= 0 ? v : DEFAULT_JUMP_SORT;
}

function writeJumpSort(v) {
  try {
    const d = new Date();
    d.setTime(d.getTime() + 365 * 24 * 60 * 60 * 1000);
    document.cookie = 'flysight_jump_sort=' + encodeURIComponent(v) +
      ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  } catch (e) {}
  try { localStorage.setItem('flysight_jump_sort', v); } catch (e) {}
}

// Flip between oldest-first and newest-first, then re-render. The direction is
// shared app-wide, so the compare modal's list re-renders too when it's open.
function toggleJumpSort() {
  writeJumpSort(readJumpSort() === 'date-asc' ? 'date-desc' : 'date-asc');
  renderJumpList();
  const cmp = document.getElementById('compareModal');
  if (cmp && cmp.classList.contains('open') && typeof renderCompareJumpsList === 'function') {
    try { renderCompareJumpsList(); } catch (e) {}
  }
}

// Date comparator for the active direction. Undated jumps (unreadable CSV and
// no addedAt) always sink last, tie-broken by name.
function jumpSortComparator(mode) {
  const time = it => (it.date ? it.date.getTime() : null);
  const byName = (a, b) => {
    try { return a.jump.name.localeCompare(b.jump.name, currentLang, { numeric: true, sensitivity: 'base' }); }
    catch (e) { return a.jump.name < b.jump.name ? -1 : (a.jump.name > b.jump.name ? 1 : 0); }
  };
  const dir = (mode === 'date-desc') ? -1 : 1;
  return (a, b) => {
    const ta = time(a), tb = time(b);
    if (ta == null && tb == null) return byName(a, b);
    if (ta == null) return 1;
    if (tb == null) return -1;
    return (ta - tb) * dir;
  };
}

// Group jumps into day runs, shared by the sidebar list and the compare modal's
// list so the two can't drift on grouping or sort semantics. Pure — no DOM.
// Each jump's date is its flight date from the CSV, falling back to its upload
// time; undated jumps (unreadable CSV and no addedAt) come back separately and
// belong at the bottom of the list.
// Note the input array is not sorted in place: callers key other things
// (compare colors) off the stored order.
function buildJumpDayGroups(jumps, sortMode) {
  const items = jumps.map(j => {
    // Index entries (getJumpIndex()) carry the date already; full rows don't.
    const flight = j.flightDate !== undefined ? j.flightDate : jumpFlightDate(j.csv);
    return { jump: j, date: flight || (j.addedAt ? new Date(j.addedAt) : null) };
  });
  items.sort(jumpSortComparator(sortMode));

  const groups = [];
  const undated = [];
  let last = null;
  items.forEach(it => {
    if (!it.date) { undated.push(it); return; }
    const dayKey = jumpDayKey(it.date);
    if (!last || last.dayKey !== dayKey) {
      last = { dayKey: dayKey, date: it.date, items: [] };
      groups.push(last);
    }
    last.items.push(it);
  });
  return { groups: groups, undated: undated };
}

// One collapsible day group: a header strip (date, count, a collapse caret on
// the right) plus the wrapper its jumps go into. Returns the pieces so
// the caller can add its own header controls (the compare list's select-all
// checkbox) before filling the wrapper.
function makeJumpDayGroup(opts) {
  const group = document.createElement('div');
  group.className = 'jump-day' + (opts.collapsed ? ' collapsed' : '');
  const header = document.createElement('div');
  header.className = 'jump-day-header';
  header.setAttribute('aria-expanded', opts.collapsed ? 'false' : 'true');
  const label = document.createElement('span');
  label.className = 'jump-day-label';
  label.textContent = formatJumpDayHeader(opts.date);
  const count = document.createElement('span');
  count.className = 'jump-day-count';
  count.textContent = '(' + opts.count + ')';
  // The caret is drawn by CSS (a rotated border corner), so it is crisp and
  // centred in every font; it points up when open and down when collapsed.
  const toggle = document.createElement('span');
  toggle.className = 'jump-day-toggle';
  toggle.setAttribute('aria-hidden', 'true');
  header.appendChild(label);
  header.appendChild(count);
  header.appendChild(toggle);

  const dk = opts.dayKey;
  const storageKey = opts.storageKey;
  header.addEventListener('click', function() {
    const set = getCollapsedDays(storageKey);
    const nowCollapsed = group.classList.toggle('collapsed');
    if (nowCollapsed) set.add(dk); else set.delete(dk);
    header.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
    saveCollapsedDays(set, storageKey);
  });

  const jumpsWrap = document.createElement('div');
  jumpsWrap.className = 'jump-day-jumps';
  group.appendChild(header);
  group.appendChild(jumpsWrap);
  return { group: group, header: header, jumpsWrap: jumpsWrap };
}

// One collapsible year in the sidebar: a header line (the year, its jump
// count, a caret) above that year's day cards. `fill(body)` builds the days;
// it runs only once the year is open, so a folded year costs one line of DOM.
function makeJumpYearGroup(opts) {
  const section = document.createElement('div');
  section.className = 'jump-year' + (opts.collapsed ? ' collapsed' : '');
  const header = document.createElement('div');
  header.className = 'jump-year-header';
  header.setAttribute('aria-expanded', opts.collapsed ? 'false' : 'true');
  const label = document.createElement('span');
  label.className = 'jump-year-label';
  label.textContent = String(opts.year);
  const count = document.createElement('span');
  count.className = 'jump-year-count';
  count.textContent = opts.count === 1 ? t('list.yearJumpsOne') : t('list.yearJumps', { count: opts.count });
  const toggle = document.createElement('span');
  toggle.className = 'jump-day-toggle';
  toggle.setAttribute('aria-hidden', 'true');
  header.appendChild(label);
  header.appendChild(count);
  header.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'jump-year-days';
  let filled = false;
  const fillOnce = () => {
    if (filled) return;
    filled = true;
    opts.fill(body);
  };
  if (!opts.collapsed) fillOnce();

  header.addEventListener('click', function() {
    const nowCollapsed = section.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
    if (!nowCollapsed) fillOnce();
    const map = getCollapsedYears();
    map[opts.year] = nowCollapsed;
    saveCollapsedYears(map);
  });

  section.appendChild(header);
  section.appendChild(body);
  return section;
}

// The date sort toggle: an arrow pointing the way the dates run (↑ oldest
// first / ↓ newest first). With `withLabel` the direction is also spelled out
// before the arrow (the sidebar's bar above the days), so no tooltip is needed.
// Click never collapses a day.
function makeJumpSortToggle(mode, withLabel) {
  const btn = document.createElement('button');
  btn.className = 'jump-sort-toggle';
  btn.type = 'button';
  const arrow = mode === 'date-desc' ? '↓' : '↑';
  const tip = t(mode === 'date-desc' ? 'sort.dateDesc' : 'sort.dateAsc');
  btn.textContent = withLabel ? tip + ' ' + arrow : arrow;
  if (!withLabel) btn.setAttribute('data-tip', tip);
  btn.setAttribute('aria-label', tip);
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    toggleJumpSort();
  });
  return btn;
}

// Trash can for the jump chip's delete button, from the same path as the video
// widget's delete circle (TRASH_ICON_PATH in widgets/core.js). Inline SVG rather
// than the 🗑 character, which renders as a full-colour emoji on most platforms;
// stroked in currentColor so it follows the button's grey / hover-white like
// the glyphs beside it.
const TRASH_ICON_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" ' +
  'stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ' +
  'aria-hidden="true"><path d="' + TRASH_ICON_PATH + '"/></svg>';

async function renderJumpList() {
  const list = document.getElementById('jumpList');
  const jumps = await getJumpIndex();
  let scores = {};
  try { scores = JSON.parse(localStorage.getItem('flysight_scores') || '{}'); } catch (e) {}
  const hasLoading = state.loadingJumps.size > 0 || !!state.importProgress;
  document.body.classList.toggle('has-jumps', jumps.length > 0 || hasLoading);
  // Read back by the inline script after <body> to pick the dropzone size before paint.
  try { localStorage.setItem('flysight_has_jumps', jumps.length > 0 ? '1' : '0'); } catch (e) {}
  updateDownloadAllLabel(jumps.length);
  list.innerHTML = '';
  const storedNames = new Set(jumps.map(j => j.name));

  // Sort by date in the user's chosen direction and group same-day jumps into
  // collapsible days (shared with the compare modal's list).
  const sortMode = readJumpSort();
  const { groups, undated } = buildJumpDayGroups(jumps, sortMode);
  const collapsed = getCollapsedDays();

  const appendJump = (target, j) => {
    // If a stored jump is being reprocessed (same filename re-dropped), show
    // it as a spinner row instead of the regular chip until the new parse
    // finishes.
    if (state.loadingJumps.has(j.name)) {
      target.appendChild(makeLoadingChip(j.name));
      return;
    }
    const chip = document.createElement('div');
    chip.className = 'jump-chip' + (j.name === state.currentJumpName ? ' active' : '');
    chip.dataset.name = j.name;
    const score = scores[j.name];
    const scoreLabel = score ? ` <span class="score">(${score.toFixed(1)} km/h)</span>` : '';
    const safeName = j.name.replace(/'/g, "\\'");
    chip.setAttribute('onclick', `selectJump('${safeName}')`);
    chip.innerHTML = `
      <span>${j.name}${scoreLabel}</span>
      <button class="edit-btn" onclick="event.stopPropagation(); openRenameModal('${safeName}')" data-tip="${t('tip.rename')}">&#x270E;</button>
      <button class="download-btn" onclick="event.stopPropagation(); downloadJump('${safeName}')" data-tip="${t('tip.downloadCsv')}">&#x2913;</button>
      <button class="delete-btn" onclick="event.stopPropagation(); deleteJump('${safeName}')" data-tip="${t('tip.remove')}" aria-label="${t('tip.remove')}">${TRASH_ICON_SVG}</button>
    `;
    target.appendChild(chip);
  };

  // The sort toggle sits in its own bar above the days: it orders the whole
  // list, and inside the first day header it read as that day's setting.
  if (groups.length > 0) {
    const bar = document.createElement('div');
    bar.className = 'jump-list-bar';
    bar.appendChild(makeJumpSortToggle(sortMode, true));
    list.appendChild(bar);
  }

  const appendDay = (target, g) => {
    const { group, header, jumpsWrap } = makeJumpDayGroup({
      date: g.date,
      dayKey: g.dayKey,
      count: g.items.length,
      collapsed: collapsed.has(g.dayKey)
    });
    // Trash button before the caret: deletes the whole day, with one undo.
    const dayNames = g.items.map(it => it.jump.name);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'jump-day-delete';
    del.innerHTML = TRASH_ICON_SVG;
    del.setAttribute('data-tip', t('tip.deleteDay'));
    del.setAttribute('aria-label', t('tip.deleteDay'));
    del.addEventListener('click', e => {
      e.stopPropagation();
      deleteJumpDay(dayNames, g.date);
    });
    header.insertBefore(del, header.querySelector('.jump-day-toggle'));
    g.items.forEach(it => appendJump(jumpsWrap, it.jump));
    target.appendChild(group);
  };

  // Once the jumps span two or more years, the days are grouped by year, each
  // year folding to one line. With a single year there is no year level at all.
  // Groups are date-sorted, so each year's days are one contiguous run.
  const yearOf = g => g.date.getUTCFullYear();
  const years = [...new Set(groups.map(yearOf))];
  if (years.length >= 2) {
    const newestYear = Math.max(...years);
    const collapsedYears = getCollapsedYears();
    years.forEach(year => {
      const yearDays = groups.filter(g => yearOf(g) === year);
      list.appendChild(makeJumpYearGroup({
        year: year,
        count: yearDays.reduce((n, g) => n + g.items.length, 0),
        collapsed: isYearCollapsed(collapsedYears, year, newestYear),
        fill: body => yearDays.forEach(g => appendDay(body, g))
      }));
    });
  } else {
    groups.forEach(g => appendDay(list, g));
  }
  // Undated jumps (unreadable CSV and no addedAt — none in practice) fall back
  // to the flat list at the bottom.
  undated.forEach(it => appendJump(list, it.jump));

  // Append loading chips for filenames that haven't landed in IndexedDB yet
  // (i.e. brand-new uploads, not re-uploads of an existing jump). They have no
  // CSV yet, so they sit at the bottom until parsed and re-rendered into a day.
  state.loadingJumps.forEach(name => {
    if (storedNames.has(name)) return;
    list.appendChild(makeLoadingChip(name));
  });
  if (state.importProgress) {
    const chip = makeLoadingChip(importProgressText());
    chip.id = 'importProgressChip';
    list.appendChild(chip);
  }
}

function findJumpChip(name) {
  return Array.from(document.querySelectorAll('#jumpList .jump-chip')).find(c => c.dataset.name === name) || null;
}

// Move the highlight to the jump just opened without rebuilding the list.
// Rebuilds only when its chip isn't there (a jump just put back by undo).
function markActiveJumpChip(name) {
  const chip = findJumpChip(name);
  if (!chip) { renderJumpList(); return; }
  document.querySelectorAll('#jumpList .jump-chip.active').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
}

// Refresh one chip's score label once renderCurrentJump() has scored the jump,
// the same "(312.4 km/h)" renderJumpList() writes.
function updateJumpChipScore(name, score) {
  const chip = findJumpChip(name);
  if (!chip) return;
  const label = chip.querySelector(':scope > span');
  let el = label.querySelector('.score');
  if (!score) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('span');
    el.className = 'score';
    label.append(' ', el);
  }
  el.textContent = '(' + score.toFixed(1) + ' km/h)';
}

// Open a jump picked somewhere other than the sidebar (the season graph): its
// day and year are unfolded if collapsed, and its chip scrolled into view once
// the list has re-rendered, so the open jump is never hidden in a folded day.
async function openJumpFromElsewhere(name) {
  const jump = (await getJumpIndex()).find(j => j.name === name);
  if (!jump) return;
  // Same day key as buildJumpDayGroups(), including its addedAt fallback.
  const date = jump.flightDate || (jump.addedAt ? new Date(jump.addedAt) : null);
  if (date) {
    const collapsed = getCollapsedDays();
    if (collapsed.delete(jumpDayKey(date))) saveCollapsedDays(collapsed);
    // Stored as open even when the list has a single year and shows no year
    // level: harmless, and right once a second year arrives.
    const years = getCollapsedYears();
    years[date.getUTCFullYear()] = false;
    saveCollapsedYears(years);
  }
  const opening = selectJump(name);
  await renderJumpList();
  const chip = document.querySelector('#jumpList .jump-chip.active');
  if (chip) chip.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  await opening;
}

// Bumped per selectJump() so only the latest of several quick clicks clears
// the loading scaffold.
let jumpSwitchSeq = 0;

// The jump open when the page was last used, reopened by the init code below.
const LAST_JUMP_KEY = 'flysight_last_jump';

async function selectJump(name) {
  state.currentJumpName = name;
  try { localStorage.setItem(LAST_JUMP_KEY, name); } catch (e) {}
  markActiveJumpChip(name);
  // With a jump already on screen, swap it for a same-sized scaffold first:
  // rendering takes most of a second, and until then the old jump's data stayed
  // up. The first jump of a session has nothing to keep the place of, so it
  // just appears.
  const section = document.getElementById('chartSection');
  if (section.style.display !== 'block') { await renderCurrentJump(); return; }
  const seq = ++jumpSwitchSeq;
  section.classList.add('is-loading');
  // The map isn't scaffolded (its imagery stays up), but the old jump's track
  // and markers go now rather than when the new ones are drawn.
  if (state.mapOverlay) state.mapOverlay.clearLayers();
  if (state.hoverMarker) { state.mapInstance.removeLayer(state.hoverMarker); state.hoverMarker = null; }
  if (state.mapHoverTooltip) state.mapInstance.closeTooltip(state.mapHoverTooltip);
  // Its hover handlers still point at the old track; renderMap() adds new ones.
  if (state.mapHandlers) state.mapInstance.off(state.mapHandlers);
  // Read (and reset) by renderMap(), so only this redraw fades in, not the
  // ones that follow the chart's zoom and pan.
  state.mapFadeIn = true;
  // rAF runs before the frame is painted; the timeout lands after it, so the
  // scaffold is on screen before the synchronous render starts. A hidden tab
  // fires no frames at all, hence the 100 ms fallback.
  await new Promise(resolve => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 100);
  });
  try {
    await renderCurrentJump();
  } finally {
    if (seq === jumpSwitchSeq) section.classList.remove('is-loading');
  }
}

// Save a Blob through a temporary Object URL. The revoke is deferred because
// some browsers cancel a large download whose URL is revoked during click().
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function jumpCsvFilename(name) {
  return name.toLowerCase().endsWith('.csv') ? name : name + '.csv';
}

async function downloadJump(name) {
  const jump = await getJump(name);
  if (!jump) return;
  saveBlob(new Blob([jump.csv], { type: 'text/csv' }), jumpCsvFilename(name));
}

// ── Download all jumps ──
// The footer's "Download all jump files" link: every stored CSV in one ZIP
// (scripts/zip.js), one folder per UTC flight day ("2026-09-05/10-25-52.csv"),
// the same day the jump list groups it under. Undated jumps go at the root.
const ZIP_UNSAFE_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

function zipEntryPath(jump, taken) {
  const d = jumpFlightDate(jump.csv);
  const p = n => String(n).padStart(2, '0');
  const folder = d ? d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + '/' : '';
  // A renamed jump can hold any character, so make the name safe on Windows.
  const file = jumpCsvFilename(jump.name.replace(ZIP_UNSAFE_CHARS, '_').trim() || 'jump');
  // Windows and macOS compare paths case-insensitively, so dedupe that way.
  let path = folder + file;
  for (let n = 2; taken.has(path.toLowerCase()); n++) {
    path = folder + file.replace(/(\.csv)$/i, ' (' + n + ')$1');
  }
  taken.add(path.toLowerCase());
  return { path, date: d || (jump.addedAt ? new Date(jump.addedAt) : null) };
}

// The label carries the jump count, so it is set from renderJumpList() (which
// applyLanguage() re-runs) rather than through data-i18n.
function updateDownloadAllLabel(count) {
  const btn = document.getElementById('downloadAllBtn');
  if (!btn) return;
  btn.dataset.count = count;
  // "Download all 1 jump files" reads badly, so a single jump gets its own line.
  if (!btn.disabled) btn.textContent = Number(count) === 1 ? t('footer.downloadOne') : t('footer.downloadAll', { count });
}

async function downloadAllJumps() {
  const btn = document.getElementById('downloadAllBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = t('footer.downloadAllBusy');
  try {
    const jumps = await getStoredJumps();
    if (!jumps.length) return;
    // A single jump without a note is saved as the CSV itself; a ZIP of one
    // file is just an extra step.
    if (jumps.length === 1 && !getJumpNote(jumps[0].name).trim()) {
      saveBlob(new Blob([jumps[0].csv], { type: 'text/csv' }), jumpCsvFilename(jumps[0].name));
      return;
    }
    // No nextPaint() here: rAF never fires in a background tab, so it would
    // stall the download, and every step below is async and lets the label paint.
    const taken = new Set();
    const entries = [];
    for (const j of jumps) {
      const { path, date } = zipEntryPath(j, taken);
      entries.push({ path, date, data: j.csv });
      // The jump's note, if it has one, sits beside its CSV: "10-25-52 - note.txt".
      const note = getJumpNote(j.name);
      if (note.trim()) entries.push({ path: path.replace(/\.csv$/i, '') + ' - note.txt', date, data: note });
    }
    const blob = await buildZip(entries);
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    saveBlob(blob, 'flysight-jumps-' + now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) + '.zip');
  } catch (e) {
    console.error('Download all failed', e);
    alert(t('alert.zipFailed', { error: e && e.message ? e.message : String(e) }));
  } finally {
    btn.disabled = false;
    updateDownloadAllLabel(btn.dataset.count || 0);
  }
}

// ── Rename jump ──
// Opens a small modal with the current name pre-filled. Saving re-keys the
// IndexedDB row and migrates the side-channel state (scores, exit override,
// compare caches, active selection) that's also keyed by jump name.
function openRenameModal(name) {
  const modal = document.getElementById('renameModal');
  const input = document.getElementById('renameInput');
  modal.dataset.oldName = name;
  input.value = name;
  modal.classList.add('open');
  input.focus();
  input.select();
}

function closeRenameModal() {
  const modal = document.getElementById('renameModal');
  modal.classList.remove('open');
  delete modal.dataset.oldName;
}

// Escape dismisses the rename modal (backdrop clicks are ignored, matching the
// other modals).
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('renameModal').classList.contains('open')) {
    closeRenameModal();
  }
});

async function confirmRename() {
  const modal = document.getElementById('renameModal');
  const oldName = modal.dataset.oldName;
  const newName = document.getElementById('renameInput').value.trim();
  if (!oldName) return closeRenameModal();
  if (!newName || newName === oldName) return closeRenameModal();

  const jumps = await getJumpIndex();
  if (jumps.some(j => j.name === newName)) {
    alert(t('alert.jumpExists', { name: newName }));
    return;
  }

  const ok = await renameJump(oldName, newName);
  if (!ok) return closeRenameModal();

  // Migrate side-channel state keyed by jump name.
  migrateLocalStorageKey('flysight_scores', oldName, newName);
  migrateLocalStorageKey('flysight_exit_overrides', oldName, newName);
  migrateLocalStorageKey('flysight_notes', oldName, newName);
  migrateLocalStorageKey('flysight_season_hidden', oldName, newName);
  if (state.compareDataCache && state.compareDataCache.has(oldName)) {
    state.compareDataCache.set(newName, state.compareDataCache.get(oldName));
    state.compareDataCache.delete(oldName);
  }
  if (state.compareSelected && state.compareSelected.has(oldName)) {
    state.compareSelected.delete(oldName);
    state.compareSelected.add(newName);
  }
  if (state.currentJumpName === oldName) {
    state.currentJumpName = newName;
    try { localStorage.setItem(LAST_JUMP_KEY, newName); } catch (e) {}
  }

  closeRenameModal();
  await renderJumpList();
}

// Move a value from one key to another inside a small JSON object stored in
// localStorage (used for the per-jump scores / exit-override maps).
function migrateLocalStorageKey(storeKey, oldName, newName) {
  try {
    const obj = JSON.parse(localStorage.getItem(storeKey) || '{}');
    if (Object.prototype.hasOwnProperty.call(obj, oldName)) {
      obj[newName] = obj[oldName];
      delete obj[oldName];
      localStorage.setItem(storeKey, JSON.stringify(obj));
    }
  } catch (e) { /* ignore */ }
}

// ── Delete with undo ──
// Deleting is immediate, with no confirm dialog: a toast offers to put it back
// for UNDO_TIMEOUT_MS instead (paused while hovered). The removed rows and their
// name-keyed side state are held in memory only, so a reload ends the chance to
// undo, and a new delete replaces the pending one.
const UNDO_TIMEOUT_MS = 10000;
let pendingUndo = null;   // { rows, overrides, notes, wasCurrent, describe }
let undoTimer = null;

function deleteJump(name) {
  return deleteJumps([name], () => t('toast.deletedOne', { name }));
}

// The trash button on a day header: every jump that day, in one undo. A whole
// day is a lot to lose to a stray click, so it asks first; the undo stays too.
function deleteJumpDay(names, date) {
  if (!confirm(t('confirm.deleteDay', { count: names.length, date: formatJumpDayHeader(date) }))) return;
  if (names.length === 1) return deleteJump(names[0]);
  return deleteJumps(names, () => t('toast.deletedDay', { count: names.length, date: formatJumpDayHeader(date) }));
}

// `describe` builds the toast text, so it can be re-run on a language switch.
async function deleteJumps(names, describe) {
  // A file still being read would be written back by handleFiles() anyway.
  names = names.filter(n => !state.loadingJumps.has(n));
  if (!names.length) return;
  const rows = await removeJumps(names);
  const overrides = {};
  const notes = {};
  let wasCurrent = null;
  rows.forEach(row => {
    const name = row.name;
    const override = getExitOverride(name);
    if (override !== null) overrides[name] = override;
    const note = getJumpNote(name);
    if (note) notes[name] = note;
    if (state.compareDataCache) state.compareDataCache.delete(name);
    if (state.compareSelected) state.compareSelected.delete(name);
    clearExitOverride(name);
    clearJumpNote(name);
    if (state.currentJumpName === name) wasCurrent = name;
  });
  if (wasCurrent) {
    state.currentJumpName = null;
    document.getElementById('chartSection').style.display = 'none';
    document.body.classList.remove('has-jump-loaded');
  }
  await renderJumpList();
  if (rows.length) showUndoToast({ rows, overrides, notes, wasCurrent, describe });
}

async function undoDelete() {
  const u = pendingUndo;
  if (!u) return;
  hideUndoToast();
  // A file uploaded under the same name since the delete wins over the old copy.
  const stored = new Set((await getJumpIndex()).map(j => j.name));
  const rows = u.rows.filter(r => !stored.has(r.name));
  if (!rows.length) return;
  await restoreJumps(rows);
  rows.forEach(r => {
    if (Object.prototype.hasOwnProperty.call(u.overrides, r.name)) setExitOverride(r.name, u.overrides[r.name]);
    if (u.notes[r.name]) setJumpNote(r.name, u.notes[r.name]);
  });
  // Reopen the jump that was on screen, unless another one has been opened since.
  if (u.wasCurrent && !state.currentJumpName && rows.some(r => r.name === u.wasCurrent)) {
    await selectJump(u.wasCurrent);
  } else {
    await renderJumpList();
  }
}

function startUndoTimer() {
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndoToast, UNDO_TIMEOUT_MS);
}

function showUndoToast(undo) {
  pendingUndo = undo;
  refreshUndoToastLang();
  document.getElementById('undoToast').hidden = false;
  startUndoTimer();
}

function hideUndoToast() {
  clearTimeout(undoTimer);
  undoTimer = null;
  pendingUndo = null;
  document.getElementById('undoToast').hidden = true;
}

// Called from applyLanguage(); the Undo button itself is translated by data-i18n.
function refreshUndoToastLang() {
  if (pendingUndo) document.getElementById('undoToastText').textContent = pendingUndo.describe();
}

(function initUndoToast() {
  const toast = document.getElementById('undoToast');
  document.getElementById('undoToastBtn').addEventListener('click', undoDelete);
  document.getElementById('undoToastClose').addEventListener('click', hideUndoToast);
  // Hovering holds the toast, so reading it never races the timer.
  toast.addEventListener('mouseenter', () => clearTimeout(undoTimer));
  toast.addEventListener('mouseleave', () => { if (pendingUndo) startUndoTimer(); });
  // Ctrl+Z / Cmd+Z while the toast shows, unless a text field or a modal has
  // its own claim on the shortcut (the notes box has native undo).
  document.addEventListener('keydown', e => {
    if (!pendingUndo || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
    const el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (document.querySelector('.modal-backdrop.open')) return;
    e.preventDefault();
    undoDelete();
  });
})();

// ── Canvas interaction: drag-from-picker & widget move/resize ──
(function() {
  const canvas = document.getElementById('overlayPreviewCanvas');

  canvas.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  canvas.addEventListener('drop', e => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/plain');
    if (!WIDGET_TYPES[type]) return;
    const rect = getVideoContentRect();
    const canvasRect = canvas.getBoundingClientRect();
    const cx = e.clientX - canvasRect.left - rect.offX;
    const cy = e.clientY - canvasRect.top - rect.offY;
    const fracX = Math.max(0.05, Math.min(0.95, cx / rect.contentW));
    const fracY = Math.max(0.05, Math.min(0.95, cy / rect.contentH));
    const w = createWidget(type, fracX, fracY);
    if (w) {
      state.selectedWidgetId = w.id;
      updateWidgetSettingsPanel();
      drawOverlayPreview();
      if (type === 'image') openImageWidgetPicker(w);
    }
  });

  canvas.addEventListener('mousedown', e => {
    const rect = getVideoContentRect();
    const canvasRect = canvas.getBoundingClientRect();
    const mx = e.clientX - canvasRect.left - rect.offX;
    const my = e.clientY - canvasRect.top - rect.offY;

    const hit = hitTestWidgets(mx, my, { width: rect.contentW, height: rect.contentH });
    if (hit) {
      if (hit.handle === 'delete') {
        removeWidget(hit.widget.id);
        return;
      }

      state.selectedWidgetId = hit.widget.id;
      updateWidgetSettingsPanel();

      if (hit.handle) {
        state.widgetDragState = {
          mode: 'resize', widgetId: hit.widget.id,
          startX: mx, startY: my,
          origX: hit.widget.x, origY: hit.widget.y,
          origW: hit.widget._bounds ? hit.widget._bounds.w : 0,
          origH: hit.widget._bounds ? hit.widget._bounds.h : 0,
          origScale: hit.widget.widgetScale || 1,
          handle: hit.handle, contentW: rect.contentW, contentH: rect.contentH,
        };
      } else {
        state.widgetDragState = {
          mode: 'move', widgetId: hit.widget.id,
          startX: mx, startY: my,
          origX: hit.widget.x, origY: hit.widget.y,
          contentW: rect.contentW, contentH: rect.contentH,
        };
      }
      drawOverlayPreview();
    } else {
      state.selectedWidgetId = null;
      updateWidgetSettingsPanel();
      drawOverlayPreview();
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (!state.widgetDragState) {
      const rect = getVideoContentRect();
      const canvasRect = canvas.getBoundingClientRect();
      const mx = e.clientX - canvasRect.left - rect.offX;
      const my = e.clientY - canvasRect.top - rect.offY;
      const hit = hitTestWidgets(mx, my, { width: rect.contentW, height: rect.contentH });
      if (hit && hit.handle === 'delete') {
        canvas.style.cursor = 'pointer';
      } else if (hit && hit.handle) {
        canvas.style.cursor = (hit.handle === 'nw' || hit.handle === 'se') ? 'nwse-resize' : 'nesw-resize';
      } else if (hit) {
        canvas.style.cursor = 'move';
      } else {
        canvas.style.cursor = 'default';
      }
      return;
    }

    const rect = getVideoContentRect();
    const canvasRect = canvas.getBoundingClientRect();
    const mx = e.clientX - canvasRect.left - rect.offX;
    const my = e.clientY - canvasRect.top - rect.offY;
    const ds = state.widgetDragState;
    const widget = state.widgets.find(w => w.id === ds.widgetId);
    if (!widget) return;

    if (ds.mode === 'move') {
      const dx = (mx - ds.startX) / ds.contentW;
      const dy = (my - ds.startY) / ds.contentH;
      widget.x = Math.max(0.05, Math.min(0.95, ds.origX + dx));
      widget.y = Math.max(0.05, Math.min(0.95, ds.origY + dy));
      drawOverlayPreview();
      state.scheduleSaveWidgetLayout();
    } else if (ds.mode === 'resize') {
      const origDiag = Math.sqrt(ds.origW * ds.origW + ds.origH * ds.origH);
      if (origDiag > 0) {
        const wcx = widget.x * ds.contentW;
        const wcy = widget.y * ds.contentH;
        const distNow = Math.sqrt((mx - wcx) * (mx - wcx) + (my - wcy) * (my - wcy));
        const distOrig = origDiag / 2;
        const ratio = distNow / distOrig;
        widget.widgetScale = Math.max(0.3, Math.min(3.0, (ds.origScale || 1) * ratio));
        drawOverlayPreview();
        state.scheduleSaveWidgetLayout();
      }
    }
  });

  canvas.addEventListener('mouseup', () => {
    state.widgetDragState = null;
  });

  canvas.addEventListener('mouseleave', () => {
    state.widgetDragState = null;
    canvas.style.cursor = 'default';
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Delete' && state.selectedWidgetId !== null) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      removeWidget(state.selectedWidgetId);
    }
  });
})();

// ── Widget picker drag start ──
(function() {
  document.querySelectorAll('.widget-card[draggable]').forEach(card => {
    card.addEventListener('dragstart', e => {
      const type = card.getAttribute('data-widget-type');
      e.dataTransfer.setData('text/plain', type);
      e.dataTransfer.effectAllowed = 'copy';
    });

    card.addEventListener('click', () => {
      const type = card.getAttribute('data-widget-type');
      if (!WIDGET_TYPES[type]) return;
      const defaultPositions = {
        info: { x: 0.85, y: 0.15 },
        altimeter: { x: 0.15, y: 0.15 },
        miniMap: { x: 0.85, y: 0.85 },
        gForce: { x: 0.15, y: 0.5 },
        image: { x: 0.5, y: 0.5 },
      };
      const defaultPos = defaultPositions[type] || { x: 0.15, y: 0.85 };
      const w = createWidget(type, defaultPos.x, defaultPos.y);
      if (w) {
        state.selectedWidgetId = w.id;
        updateWidgetSettingsPanel();
        drawOverlayPreview();
        if (type === 'image') openImageWidgetPicker(w);
      }
    });
  });
})();

// Render widget card previews on load
renderWidgetPreviews();

// ── Resizable panels (chart + map) ──
// A drag handle pinned to a panel's bottom edge lets the user set its height.
// The chosen height persists in a cookie (1-year), mirrored to localStorage as a
// fallback for file:// origins that drop cookies — same pattern as theme/lang.
(function() {
  function makeResizable(opts) {
    var handle = document.getElementById(opts.handleId);
    var target = document.getElementById(opts.targetId);
    if (!handle || !target) return;
    var STORE_KEY = opts.storeKey;
    var MIN = opts.minHeight;
    var re = new RegExp('(?:^|;\\s*)' + STORE_KEY + '=([^;]+)');

    function save(px) {
      try {
        var d = new Date();
        d.setTime(d.getTime() + 365 * 24 * 60 * 60 * 1000);
        document.cookie = STORE_KEY + '=' + px +
          ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
      } catch (e) {}
      try { localStorage.setItem(STORE_KEY, String(px)); } catch (e) {}
    }
    function read() {
      var v = null;
      try { var m = document.cookie.match(re); if (m) v = m[1]; } catch (e) {}
      if (v == null) { try { v = localStorage.getItem(STORE_KEY); } catch (e) {} }
      return parseInt(v, 10);
    }
    function apply(px) { opts.onApply(target, px); }

    // Restore saved height (if any); otherwise the CSS default applies.
    var saved = read();
    if (Number.isFinite(saved) && saved >= MIN) apply(saved);

    var dragging = false, startY = 0, startH = 0;

    function onMove(e) {
      if (!dragging) return;
      var clientY = e.touches ? e.touches[0].clientY : e.clientY;
      apply(Math.max(MIN, Math.round(startH + (clientY - startY))));
      e.preventDefault();
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      save(Math.round(target.getBoundingClientRect().height));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    }
    function onDown(e) {
      dragging = true;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startH = target.getBoundingClientRect().height;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
      e.preventDefault();
    }

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  }

  makeResizable({
    handleId: 'chartResizeHandle', targetId: 'chartCanvasWrap',
    storeKey: 'flysight_chart_height', minHeight: 300,
    onApply: function(t, px) {
      t.style.aspectRatio = 'auto';
      t.style.height = px + 'px';
      if (state.chartInstance) state.chartInstance.resize();
    },
  });
  makeResizable({
    handleId: 'mapResizeHandle', targetId: 'map',
    storeKey: 'flysight_map_height', minHeight: 500,
    onApply: function(t, px) {
      t.style.height = px + 'px';
      if (state.mapInstance) state.mapInstance.invalidateSize();
    },
  });

  // The map can't be shorter than the stats column beside it, or the grid row
  // stretches the map card and leaves an empty strip under the map. An inline
  // min-height beats the inline height the drag sets, so the drag stops there.
  (function() {
    var map = document.getElementById('map');
    var stats = document.getElementById('stats');
    if (!map || !stats) return;
    var mq = window.matchMedia('(max-width: 900px)');
    function syncMapMinHeight() {
      // Stacked layout: the stats sit above the map, so there is nothing to match.
      var px = mq.matches ? '' : Math.max(500, stats.offsetHeight) + 'px';
      if (map.style.minHeight === px) return;
      map.style.minHeight = px;
      if (state.mapInstance) state.mapInstance.invalidateSize();
    }
    if (window.ResizeObserver) new ResizeObserver(syncMapMinHeight).observe(stats);
    mq.addEventListener('change', syncMapMinHeight);
    syncMapMinHeight();
  })();

  // Horizontal splitter on the map's right edge: drags the map/stats column ratio.
  // Stored as the map's fraction of the row (0.45–0.85) in a cookie (default 0.8 = "4fr 1fr").
  (function() {
    var handle = document.getElementById('mapSplitHandle');
    var row = document.querySelector('.map-stats-row');
    if (!handle || !row) return;
    var KEY = 'flysight_map_split';
    var re = new RegExp('(?:^|;\\s*)' + KEY + '=([^;]+)');
    var MINF = 0.45, MAXF = 0.85, GAP = 16;
    var mq = window.matchMedia('(max-width: 900px)');
    var lastF = 0.8;

    function save(f) {
      try {
        var d = new Date();
        d.setTime(d.getTime() + 365 * 24 * 60 * 60 * 1000);
        document.cookie = KEY + '=' + f.toFixed(4) +
          ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
      } catch (e) {}
      try { localStorage.setItem(KEY, f.toFixed(4)); } catch (e) {}
    }
    function read() {
      var v = null;
      try { var m = document.cookie.match(re); if (m) v = m[1]; } catch (e) {}
      if (v == null) { try { v = localStorage.getItem(KEY); } catch (e) {} }
      return parseFloat(v);
    }
    function apply(f) {
      lastF = f;
      // Below 900px the layout stacks into one column (media query) — leave it alone.
      if (mq.matches) { row.style.gridTemplateColumns = ''; return; }
      row.style.gridTemplateColumns = f.toFixed(4) + 'fr ' + (1 - f).toFixed(4) + 'fr';
      if (state.mapInstance) state.mapInstance.invalidateSize();
    }

    var saved = read();
    if (Number.isFinite(saved)) lastF = Math.max(MINF, Math.min(MAXF, saved));
    if (!mq.matches && Number.isFinite(saved)) apply(lastF);
    // Re-apply / clear the inline columns when crossing the stacked-layout breakpoint.
    mq.addEventListener('change', function() { apply(lastF); });

    function fracAt(clientX) {
      var rect = row.getBoundingClientRect();
      var f = (clientX - rect.left) / (rect.width - GAP);
      return Math.max(MINF, Math.min(MAXF, f));
    }

    var dragging = false;
    function onMove(e) {
      if (!dragging) return;
      var x = e.touches ? e.touches[0].clientX : e.clientX;
      apply(fracAt(x));
      e.preventDefault();
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      save(lastF);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    }
    function onDown(e) {
      if (mq.matches) return; // no horizontal split in stacked layout
      dragging = true;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onUp);
      e.preventDefault();
    }
    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: false });
  })();
})();

// ── Init ──
(async () => {
  initJumpNotes();
  await renderJumpList();
  const jumps = await getJumpIndex();
  if (jumps.length === 0) return;
  // Reopen the jump from last time; fall back to the most recently added one
  // when it has since been deleted (or nothing was stored yet).
  let last = null;
  try { last = localStorage.getItem(LAST_JUMP_KEY); } catch (e) {}
  selectJump(jumps.some(j => j.name === last) ? last : jumps[jumps.length - 1].name);
})();
