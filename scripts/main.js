
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
    alert(
      'Only CSV files can be uploaded here.\n\nRejected: ' +
      rejected.map(f => f.name).join(', ') +
      '\n\nTo add a video, click "Create video overlay".'
    );
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

async function renderJumpList() {
  const list = document.getElementById('jumpList');
  const jumps = await getStoredJumps();
  let scores = {};
  try { scores = JSON.parse(localStorage.getItem('flysight_scores') || '{}'); } catch (e) {}
  const hasLoading = state.loadingJumps.size > 0;
  document.body.classList.toggle('has-jumps', jumps.length > 0 || hasLoading);
  list.innerHTML = '';
  const storedNames = new Set(jumps.map(j => j.name));
  jumps.forEach(j => {
    // If a stored jump is being reprocessed (same filename re-dropped), show
    // it as a spinner row instead of the regular chip until the new parse
    // finishes.
    if (state.loadingJumps.has(j.name)) {
      list.appendChild(makeLoadingChip(j.name));
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
      <button class="edit-btn" onclick="event.stopPropagation(); openRenameModal('${safeName}')" data-tip="Rename">&#x270E;</button>
      <button class="download-btn" onclick="event.stopPropagation(); downloadJump('${safeName}')" data-tip="Download CSV">&#x2913;</button>
      <button class="delete-btn" onclick="event.stopPropagation(); deleteJump('${safeName}')" data-tip="Remove">&times;</button>
    `;
    list.appendChild(chip);
  });
  // Append loading chips for filenames that haven't landed in IndexedDB yet
  // (i.e. brand-new uploads, not re-uploads of an existing jump).
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
    alert('A jump named "' + newName + '" already exists. Choose a different name.');
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

// ── Init ──
(async () => {
  await renderJumpList();
  const jumps = await getStoredJumps();
  if (jumps.length > 0) selectJump(jumps[jumps.length - 1].name);
})();
