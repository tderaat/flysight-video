
// ── File handling ──
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', e => handleFiles(e.target.files));

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
  handleFiles(e.dataTransfer.files);
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

async function handleFiles(files) {
  const all = Array.from(files);
  const csvFiles = all.filter(isCsvFile);
  const rejected = all.filter(f => !isCsvFile(f));
  if (rejected.length) {
    alert(t('alert.onlyCsv', { files: rejected.map(f => f.name).join(', ') }));
  }
  if (!csvFiles.length) return;

  // Register every dropped file as "loading" up front and render the sidebar
  // so the user sees spinner chips immediately — even before FileReader
  // finishes on the first byte. Yield to the browser so the chips paint
  // before we kick off the parse work for the first file.
  csvFiles.forEach(file => {
    state.loadingJumps.add(file.name.replace(/\.csv$/i, ''));
  });
  await renderJumpList();
  await nextPaint();

  let lastName = null;
  for (const file of csvFiles) {
    const name = file.name.replace(/\.csv$/i, '');
    try {
      const csv = await readFileAsText(file);
      await storeJump(name, csv);
      if (state.compareDataCache) state.compareDataCache.delete(name);
      lastName = name;
    } catch (e) {
      // Individual file failures shouldn't block the rest of the batch.
      console.error('Failed to load', file.name, e);
    }
    state.loadingJumps.delete(name);
    await renderJumpList();
    // Yield before the next file's CPU work so this row's spinner clears
    // and any other still-loading rows keep animating smoothly.
    await nextPaint();
  }

  if (lastName) selectJump(lastName);
}

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
// timestamp (row 1 = header, row 2 = units, row 3 = first sample). Cheap string
// slicing, no full parse. Returns null if it can't be read.
function jumpFlightDate(csv) {
  if (!csv) return null;
  const i1 = csv.indexOf('\n');
  if (i1 < 0) return null;
  const i2 = csv.indexOf('\n', i1 + 1);
  if (i2 < 0) return null;
  let i3 = csv.indexOf('\n', i2 + 1);
  if (i3 < 0) i3 = csv.length;
  const ts = csv.slice(i2 + 1, i3).split(',')[0].trim();
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
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

// Per-day collapse state for the jump list, persisted in localStorage so a
// collapsed day stays collapsed across reloads. Keyed by jumpDayKey().
function getCollapsedDays() {
  try { return new Set(JSON.parse(localStorage.getItem('flysight_collapsed_days') || '[]')); }
  catch (e) { return new Set(); }
}
function saveCollapsedDays(set) {
  try { localStorage.setItem('flysight_collapsed_days', JSON.stringify([...set])); } catch (e) {}
}

async function renderJumpList() {
  const list = document.getElementById('jumpList');
  const jumps = await getStoredJumps();
  let scores = {};
  try { scores = JSON.parse(localStorage.getItem('flysight_scores') || '{}'); } catch (e) {}
  const hasLoading = state.loadingJumps.size > 0;
  document.body.classList.toggle('has-jumps', jumps.length > 0 || hasLoading);
  list.innerHTML = '';
  const storedNames = new Set(jumps.map(j => j.name));

  // Resolve each jump's grouping date (flight date from the CSV, falling back to
  // its upload time) and sort oldest-first so same-day jumps are contiguous.
  const items = jumps.map(j => {
    const flight = jumpFlightDate(j.csv);
    const date = flight || (j.addedAt ? new Date(j.addedAt) : null);
    return { jump: j, date: date };
  });
  items.sort((a, b) => {
    const ta = a.date ? a.date.getTime() : Infinity; // undated sinks to the bottom
    const tb = b.date ? b.date.getTime() : Infinity;
    return ta - tb;
  });

  const collapsed = getCollapsedDays();
  // Jump count per day, shown after the date when a day is collapsed.
  const dayCounts = {};
  items.forEach(it => {
    if (!it.date) return;
    const k = jumpDayKey(it.date);
    dayCounts[k] = (dayCounts[k] || 0) + 1;
  });
  let lastDayKey = null;
  let dayJumpsWrap = null; // the .jump-day-jumps container for the current day
  items.forEach(({ jump: j, date }) => {
    const dayKey = date ? jumpDayKey(date) : null;
    if (date && dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      // New collapsible day group: header (chevron + label) + jumps wrapper.
      const group = document.createElement('div');
      group.className = 'jump-day' + (collapsed.has(dayKey) ? ' collapsed' : '');
      const header = document.createElement('div');
      header.className = 'jump-day-header';
      const chevron = document.createElement('span');
      chevron.className = 'jump-day-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '▾'; // ▾, rotated to ▸ when collapsed (CSS)
      const label = document.createElement('span');
      label.className = 'jump-day-label';
      label.textContent = formatJumpDayHeader(date);
      const count = document.createElement('span');
      count.className = 'jump-day-count';
      count.textContent = '(' + (dayCounts[dayKey] || 0) + ')';
      header.appendChild(label);
      header.appendChild(chevron);
      header.appendChild(count);
      const dk = dayKey;
      header.addEventListener('click', function() {
        const set = getCollapsedDays();
        if (group.classList.toggle('collapsed')) set.add(dk); else set.delete(dk);
        saveCollapsedDays(set);
      });
      dayJumpsWrap = document.createElement('div');
      dayJumpsWrap.className = 'jump-day-jumps';
      group.appendChild(header);
      group.appendChild(dayJumpsWrap);
      list.appendChild(group);
    }
    // Dated jumps go inside their day's wrapper; undated ones (none in practice)
    // fall back to the flat list.
    const target = (date && dayJumpsWrap) ? dayJumpsWrap : list;
    // If a stored jump is being reprocessed (same filename re-dropped), show
    // it as a spinner row instead of the regular chip until the new parse
    // finishes.
    if (state.loadingJumps.has(j.name)) {
      target.appendChild(makeLoadingChip(j.name));
      return;
    }
    const chip = document.createElement('div');
    chip.className = 'jump-chip' + (j.name === state.currentJumpName ? ' active' : '');
    const score = scores[j.name];
    const scoreLabel = score ? ` <span class="score">(${score.toFixed(1)} km/h)</span>` : '';
    const safeName = j.name.replace(/'/g, "\\'");
    chip.setAttribute('onclick', `selectJump('${safeName}')`);
    chip.innerHTML = `
      <span>${j.name}${scoreLabel}</span>
      <button class="edit-btn" onclick="event.stopPropagation(); openRenameModal('${safeName}')" data-tip="${t('tip.rename')}">&#x270E;</button>
      <button class="download-btn" onclick="event.stopPropagation(); downloadJump('${safeName}')" data-tip="${t('tip.downloadCsv')}">&#x2913;</button>
      <button class="delete-btn" onclick="event.stopPropagation(); deleteJump('${safeName}')" data-tip="${t('tip.remove')}">&times;</button>
    `;
    target.appendChild(chip);
  });
  // Append loading chips for filenames that haven't landed in IndexedDB yet
  // (i.e. brand-new uploads, not re-uploads of an existing jump). They have no
  // CSV yet, so they sit at the bottom until parsed and re-rendered into a day.
  state.loadingJumps.forEach(name => {
    if (storedNames.has(name)) return;
    list.appendChild(makeLoadingChip(name));
  });
}

function selectJump(name) {
  state.currentJumpName = name;
  renderJumpList();
  renderCurrentJump();
}

async function downloadJump(name) {
  const jumps = await getStoredJumps();
  const jump = jumps.find(j => j.name === name);
  if (!jump) return;
  const blob = new Blob([jump.csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.toLowerCase().endsWith('.csv') ? name : name + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

  const jumps = await getStoredJumps();
  if (jumps.some(j => j.name === newName)) {
    alert(t('alert.jumpExists', { name: newName }));
    return;
  }

  const ok = await renameJump(oldName, newName);
  if (!ok) return closeRenameModal();

  // Migrate side-channel state keyed by jump name.
  migrateLocalStorageKey('flysight_scores', oldName, newName);
  migrateLocalStorageKey('flysight_exit_overrides', oldName, newName);
  if (state.compareDataCache && state.compareDataCache.has(oldName)) {
    state.compareDataCache.set(newName, state.compareDataCache.get(oldName));
    state.compareDataCache.delete(oldName);
  }
  if (state.compareSelected && state.compareSelected.has(oldName)) {
    state.compareSelected.delete(oldName);
    state.compareSelected.add(newName);
  }
  if (state.currentJumpName === oldName) state.currentJumpName = newName;

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

async function deleteJump(name) {
  await removeJump(name);
  if (state.compareDataCache) state.compareDataCache.delete(name);
  if (state.compareSelected) state.compareSelected.delete(name);
  if (typeof clearExitOverride === 'function') clearExitOverride(name);
  if (state.currentJumpName === name) {
    state.currentJumpName = null;
    document.getElementById('chartSection').style.display = 'none';
  }
  await renderJumpList();
}

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
    storeKey: 'flysight_map_height', minHeight: 350,
    onApply: function(t, px) {
      t.style.height = px + 'px';
      if (state.mapInstance) state.mapInstance.invalidateSize();
    },
  });

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
  await renderJumpList();
  const jumps = await getStoredJumps();
  if (jumps.length > 0) selectJump(jumps[jumps.length - 1].name);
})();
