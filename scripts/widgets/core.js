// ── Shared config helper ──
function buildUnitsConfig(widget, options) {
  const unitOptions = options || [
    { value: 'metric', label: 'Metric' },
    { value: 'imperial', label: 'Imperial' },
    { value: 'both', label: 'Both' },
  ];
  const group = document.createElement('div');
  group.className = 'widget-config-group';
  const label = document.createElement('div');
  label.className = 'widget-config-group-label';
  label.textContent = 'Units';
  group.appendChild(label);
  const radios = document.createElement('div');
  radios.className = 'widget-config-checks';
  unitOptions.forEach(({ value, label }) => {
    const lbl = document.createElement('label');
    const rb = document.createElement('input');
    rb.type = 'radio';
    rb.name = 'widgetUnits_' + widget.id;
    rb.value = value;
    rb.checked = (widget.config.units || 'both') === value;
    rb.addEventListener('change', () => {
      widget.config.units = value;
      drawOverlayPreview();
      state.scheduleSaveWidgetLayout();
    });
    lbl.appendChild(rb);
    lbl.appendChild(document.createTextNode(' ' + label));
    radios.appendChild(lbl);
  });
  group.appendChild(radios);
  return group;
}

// ── Widget type registry ──
// configUI wrappers pass drawOverlayPreview and buildUnitsConfig to each widget's config builder
const WIDGET_TYPES = {
  info: {
    label: 'Info',
    defaultConfig: { showTime: true, showAltitude: true, showSpeed: true, showHSpeed: true, showDiveAngle: true, showScore: true, showBackground: true, units: 'both', fadeIn: true },
    render: renderInfoWidget,
    renderPreview: renderInfoPreviewCard,
    configUI: (widget) => buildInfoConfigPanel(widget, drawOverlayPreview, buildUnitsConfig),
  },
  vertSpeed: {
    label: 'Vert. Speed',
    defaultConfig: { dataSource: 'vertSpeed', units: 'metric', fadeIn: true, showBackground: false, showLabel: false },
    render: renderSpeedWidget,
    renderPreview: renderVertSpeedPreviewCard,
    configUI: (widget) => buildSpeedConfigPanel(widget, drawOverlayPreview, buildUnitsConfig),
  },
  horzSpeed: {
    label: 'Horiz. Speed',
    defaultConfig: { dataSource: 'horzSpeed', units: 'metric', fadeIn: true, showBackground: false, showLabel: false },
    render: renderSpeedWidget,
    renderPreview: renderHorzSpeedPreviewCard,
    configUI: (widget) => buildSpeedConfigPanel(widget, drawOverlayPreview, buildUnitsConfig),
  },
  altGraph: {
    label: 'Alt. Graph',
    defaultConfig: { showMeasuringZone: true, showScoringZone: true, showLabel: false, showBackground: false, fadeIn: true },
    render: renderAltGraphWidget,
    renderPreview: renderAltGraphPreviewCard,
    configUI: (widget) => buildAltGraphConfigPanel(widget, drawOverlayPreview),
  },
  altimeter: {
    label: 'Altimeter',
    defaultConfig: { showBackground: false, fadeIn: true },
    render: renderAltimeterWidget,
    renderPreview: renderAltimeterPreviewCard,
    configUI: (widget) => buildAltimeterConfigPanel(widget, drawOverlayPreview),
  },
  speedGraph: {
    label: 'Speed Graph',
    defaultConfig: { showMeasuringZone: true, showScoringZone: true, showLabel: false, showBackground: false, fadeIn: true },
    render: renderSpeedGraphWidget,
    renderPreview: renderSpeedGraphPreviewCard,
    configUI: (widget) => buildSpeedGraphConfigPanel(widget, drawOverlayPreview),
  },
  miniMap: {
    label: 'Mini Map',
    defaultConfig: { showBackground: true, showLabel: false, showExitMarker: true, fadeIn: true },
    render: renderMiniMapWidget,
    renderPreview: renderMiniMapPreviewCard,
    configUI: (widget) => buildMiniMapConfigPanel(widget, drawOverlayPreview),
  },
  gForce: {
    label: 'G-Force',
    defaultConfig: { showBackground: false, showLabel: false, fadeIn: true },
    render: renderGForceWidget,
    renderPreview: renderGForcePreviewCard,
    configUI: (widget) => buildGForceConfigPanel(widget, drawOverlayPreview),
  },
  image: {
    label: 'Image',
    defaultConfig: { fadeIn: false },
    render: renderImageWidget,
    renderPreview: renderImagePreviewCard,
    configUI: (widget) => buildImageConfigPanel(widget, drawOverlayPreview),
  }
};

// ── Widget CRUD ──
function createWidget(type, x, y) {
  const def = WIDGET_TYPES[type];
  if (!def) return null;
  const w = {
    id: state.nextWidgetId++,
    type: type,
    x: x,
    y: y,
    widgetScale: 1.0,
    config: { ...def.defaultConfig },
  };
  state.widgets.push(w);
  state.scheduleSaveWidgetLayout();
  return w;
}

function removeWidget(id) {
  const removed = state.widgets.find(w => w.id === id);
  if (removed && removed._imageObjectURL) {
    try { URL.revokeObjectURL(removed._imageObjectURL); } catch {}
    removed._imageObjectURL = null;
  }
  state.widgets = state.widgets.filter(w => w.id !== id);
  if (state.selectedWidgetId === id) state.selectedWidgetId = null;
  updateWidgetSettingsPanel();
  drawOverlayPreview();
  state.scheduleSaveWidgetLayout();
}

// ── Per-widget fade-in opacity ──
function getWidgetOpacity(widget, dataIdx) {
  if (!widget.config.fadeIn) return 1;
  if (state.videoExitTime === null || !state.currentFlightData) return 1;
  if (dataIdx < 0 || dataIdx >= state.currentFlightData.times.length) return 1;
  const t = state.currentFlightData.times[dataIdx];
  if (t < -3) return 0;
  if (t < 0) return (t + 3) / 3;
  return 1;
}

// ── Widget selection handles ──
function drawSelectionHandles(ctx, contentRect, widget) {
  if (!widget._bounds) return;
  const b = widget._bounds;
  const handleSize = 6;

  ctx.save();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
  ctx.setLineDash([]);

  ctx.fillStyle = '#38bdf8';
  const corners = [
    [b.x - 2, b.y - 2],
    [b.x + b.w + 2 - handleSize, b.y - 2],
    [b.x - 2, b.y + b.h + 2 - handleSize],
    [b.x + b.w + 2 - handleSize, b.y + b.h + 2 - handleSize],
  ];
  corners.forEach(([hx, hy]) => {
    ctx.fillRect(hx, hy, handleSize, handleSize);
  });

  const delSize = 16;
  const delX = b.x + b.w + 4;
  const delY = b.y - delSize - 4;
  widget._deleteBtn = { x: delX, y: delY, size: delSize };

  ctx.beginPath();
  ctx.arc(delX + delSize / 2, delY + delSize / 2, delSize / 2 + 2, 0, Math.PI * 2);
  ctx.fillStyle = '#ef4444';
  ctx.fill();

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const inset = 4;
  ctx.beginPath();
  ctx.moveTo(delX + inset, delY + inset);
  ctx.lineTo(delX + delSize - inset, delY + delSize - inset);
  ctx.moveTo(delX + delSize - inset, delY + inset);
  ctx.lineTo(delX + inset, delY + delSize - inset);
  ctx.stroke();

  ctx.restore();
}

// ── Widget hit-testing ──
function hitTestWidgets(canvasX, canvasY, contentRect) {
  for (let i = state.widgets.length - 1; i >= 0; i--) {
    const w = state.widgets[i];
    if (!w._bounds) continue;
    const b = w._bounds;
    const handleSize = 10;

    if (w.id === state.selectedWidgetId && w._deleteBtn) {
      const d = w._deleteBtn;
      const dcx = d.x + d.size / 2;
      const dcy = d.y + d.size / 2;
      if (Math.sqrt((canvasX - dcx) ** 2 + (canvasY - dcy) ** 2) < d.size / 2 + 4) {
        return { widget: w, handle: 'delete' };
      }
    }

    const corners = [
      { x: b.x - 2, y: b.y - 2, handle: 'nw' },
      { x: b.x + b.w + 2, y: b.y - 2, handle: 'ne' },
      { x: b.x - 2, y: b.y + b.h + 2, handle: 'sw' },
      { x: b.x + b.w + 2, y: b.y + b.h + 2, handle: 'se' },
    ];
    for (const c of corners) {
      if (Math.abs(canvasX - c.x) < handleSize && Math.abs(canvasY - c.y) < handleSize) {
        return { widget: w, handle: c.handle };
      }
    }

    if (canvasX >= b.x && canvasX <= b.x + b.w && canvasY >= b.y && canvasY <= b.y + b.h) {
      return { widget: w, handle: null };
    }
  }
  return null;
}

// ── Widget settings panel ──
function updateWidgetSettingsPanel() {
  const row = document.getElementById('widgetSettingsRow');
  const panel = document.getElementById('widgetSettingsPanel');
  if (!row || !panel) return;

  if (state.selectedWidgetId === null) {
    row.style.display = 'none';
    return;
  }

  const widget = state.widgets.find(w => w.id === state.selectedWidgetId);
  if (!widget) {
    row.style.display = 'none';
    return;
  }

  row.style.display = '';
  panel.innerHTML = '';

  const typeDef = WIDGET_TYPES[widget.type];
  if (typeDef && typeDef.configUI) {
    panel.appendChild(typeDef.configUI(widget));
  }
}

// ── Overlay preview ──
function drawOverlayPreview() {
  const video = document.getElementById('videoPreview');
  const canvas = document.getElementById('overlayPreviewCanvas');
  if (!canvas || !video || !video.videoWidth) return;

  const rect = getVideoContentRect();
  canvas.style.left = '0px';
  canvas.style.top = '0px';
  canvas.style.width = rect.elemW + 'px';
  canvas.style.height = rect.elemH + 'px';
  canvas.width = rect.elemW;
  canvas.height = rect.elemH;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const dataIdx = videoTimeToDataIndex(video.currentTime);

  ctx.save();
  ctx.translate(rect.offX, rect.offY);
  const contentRect = { width: rect.contentW, height: rect.contentH };

  for (const widget of state.widgets) {
    const typeDef = WIDGET_TYPES[widget.type];
    if (!typeDef) continue;
    const opacity = getWidgetOpacity(widget, dataIdx);
    typeDef.render(ctx, contentRect, widget, dataIdx, null, null, opacity);
  }

  if (state.selectedWidgetId !== null) {
    const sw = state.widgets.find(w => w.id === state.selectedWidgetId);
    if (sw) drawSelectionHandles(ctx, contentRect, sw);
  }

  ctx.restore();
}

// ── Widget preview cards ──
function renderWidgetPreviews() {
  Object.keys(WIDGET_TYPES).forEach(type => {
    const def = WIDGET_TYPES[type];
    const c = document.getElementById('widgetPreview_' + type);
    if (!c || !def.renderPreview) return;
    def.renderPreview(c.getContext('2d'), c);
  });
}
