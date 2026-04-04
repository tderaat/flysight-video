
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

function handleFiles(files) {
  Array.from(files).forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const csv = e.target.result;
      const name = file.name.replace(/\.csv$/i, '');
      storeJump(name, csv);
      renderJumpList();
      selectJump(name);
    };
    reader.readAsText(file);
  });
}

// ── Jump list rendering ──
function renderJumpList() {
  const list = document.getElementById('jumpList');
  const jumps = getStoredJumps();
  let scores = {};
  try { scores = JSON.parse(localStorage.getItem('flysight_scores') || '{}'); } catch (e) {}
  list.innerHTML = '';
  jumps.forEach(j => {
    const chip = document.createElement('div');
    chip.className = 'jump-chip' + (j.name === state.currentJumpName ? ' active' : '');
    const score = scores[j.name];
    const scoreLabel = score ? ` (${score.toFixed(1)} km/h)` : '';
    chip.innerHTML = `
      <span onclick="selectJump('${j.name.replace(/'/g, "\\'")}')">${j.name}${scoreLabel}</span>
      <button class="delete-btn" onclick="event.stopPropagation(); deleteJump('${j.name.replace(/'/g, "\\'")}')" title="Remove">&times;</button>
    `;
    list.appendChild(chip);
  });
}

function selectJump(name) {
  state.currentJumpName = name;
  renderJumpList();
  renderCurrentJump();
}

function deleteJump(name) {
  removeJump(name);
  if (state.currentJumpName === name) {
    state.currentJumpName = null;
    document.getElementById('chartSection').style.display = 'none';
  }
  renderJumpList();
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
renderJumpList();
const jumps = getStoredJumps();
if (jumps.length > 0) selectJump(jumps[jumps.length - 1].name);
