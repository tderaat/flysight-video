// ── Shared config panel helpers ──
// Every widget's settings panel is built from the same parts: a plain "Display"
// section, then toggle sections (Background, Fade in) whose controls only show
// while their checkbox is ticked.

function buildUnitsConfig(widget, options) {
  const unitOptions = options || [
    { value: 'metric', label: t('cfg.metric') },
    { value: 'imperial', label: t('cfg.imperial') },
    { value: 'both', label: t('cfg.both') },
  ];
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
  return buildConfigRow(t('cfg.units'), [radios]);
}

// A labelled row of controls: label on the left, the controls beside it.
function buildConfigRow(label, children) {
  const row = document.createElement('div');
  row.className = 'widget-config-row';
  const lbl = document.createElement('span');
  lbl.className = 'widget-config-row-label';
  lbl.textContent = label;
  row.appendChild(lbl);
  children.forEach(c => row.appendChild(c));
  return row;
}

// Checkbox list. defaultOn keys read `!== false` so widgets from a layout saved
// before the setting existed still get it (the drop shadow).
function buildConfigChecks(widget, items) {
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  items.forEach(({ key, label, defaultOn }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = defaultOn ? widget.config[key] !== false : !!widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
      state.scheduleSaveWidgetLayout();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  return checks;
}

// Section with a plain heading.
function buildConfigSection(title, children) {
  const sec = document.createElement('div');
  sec.className = 'widget-config-section';
  const head = document.createElement('div');
  head.className = 'widget-config-section-head';
  head.textContent = title;
  sec.appendChild(head);
  children.forEach(c => sec.appendChild(c));
  return sec;
}

// Section whose heading is a checkbox; the body only shows while it is ticked.
function buildToggleSection(widget, key, label, body, defaultOn) {
  const sec = document.createElement('div');
  sec.className = 'widget-config-section';
  const head = document.createElement('label');
  head.className = 'widget-config-section-head';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = defaultOn ? widget.config[key] !== false : !!widget.config[key];
  head.appendChild(cb);
  head.appendChild(document.createTextNode(' ' + label));
  body.classList.add('widget-config-section-body');
  body.hidden = !cb.checked;
  cb.addEventListener('change', () => {
    widget.config[key] = cb.checked;
    body.hidden = !cb.checked;
    drawOverlayPreview();
    state.scheduleSaveWidgetLayout();
  });
  sec.appendChild(head);
  sec.appendChild(body);
  return sec;
}

// ── Widget background colour and opacity ──
// The defaults are the dark box every widget drew before the setting existed (75 %,
// rounded to the slider's 10 % step), so saved layouts without the keys barely change.
const WIDGET_BG_DEFAULT_COLOR = '#0f172a';
const WIDGET_BG_DEFAULT_OPACITY = 80;            // percent
const WIDGET_OPACITY_STEP = 10;               // percent
const WIDGET_OPACITY_LABELS = [0, 50, 100];

function widgetBackgroundFill(config) {
  const color = configColor(config, 'bgColor', WIDGET_BG_DEFAULT_COLOR);
  const opacity = Number.isFinite(config.bgOpacity) ? config.bgOpacity : WIDGET_BG_DEFAULT_OPACITY;
  return hexToRgba(color, opacity / 100);
}

// Colour row: swatch, hex value, and a Reset that only shows once the colour differs
// from the default. Reset deletes the key, so the renderer's default applies again.
function buildColorRow(widget, key, defaultColor, label) {
  const color = document.createElement('input');
  color.type = 'color';
  color.className = 'widget-bg-color';
  color.value = widget.config[key] || defaultColor;
  color.setAttribute('aria-label', label);
  const hex = document.createElement('span');
  hex.className = 'widget-bg-hex';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'widget-bg-reset';
  reset.textContent = t('cfg.reset');
  function refreshColor() {
    hex.textContent = color.value;
    reset.hidden = color.value.toLowerCase() === defaultColor;
  }
  color.addEventListener('input', () => {
    widget.config[key] = color.value;
    refreshColor();
    drawOverlayPreview();
    state.scheduleSaveWidgetLayout();
  });
  reset.addEventListener('click', () => {
    delete widget.config[key];
    color.value = defaultColor;
    refreshColor();
    drawOverlayPreview();
    state.scheduleSaveWidgetLayout();
  });
  refreshColor();
  return buildConfigRow(label, [color, hex, reset]);
}

// A hex colour from the config, or the fallback when the key is missing or malformed.
function configColor(config, key, fallback) {
  return /^#[0-9a-f]{6}$/i.test(config[key] || '') ? config[key] : fallback;
}

// Opacity row: a 0-100 % slider in 10 % steps with clickable 0 / 50 / 100 labels,
// stored in widget.config[key]. Used for the background box and the image widget.
function buildOpacityRow(widget, key, defaultValue) {
  const sliderWrap = document.createElement('div');
  sliderWrap.className = 'widget-opacity';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = WIDGET_OPACITY_STEP;
  slider.setAttribute('aria-label', t('cfg.opacity'));
  const ticks = document.createElement('div');
  ticks.className = 'widget-opacity-ticks';
  const value = document.createElement('span');
  value.className = 'widget-opacity-value';
  function showOpacity(v) {
    slider.value = v;
    value.textContent = v + ' %';
    ticks.querySelectorAll('span').forEach(s => s.classList.toggle('on', +s.dataset.v === v));
  }
  function setOpacity(v) {
    widget.config[key] = v;
    showOpacity(v);
    drawOverlayPreview();
    state.scheduleSaveWidgetLayout();
  }
  WIDGET_OPACITY_LABELS.forEach(v => {
    const tick = document.createElement('span');
    tick.dataset.v = v;
    tick.style.left = v + '%';
    tick.textContent = v;
    tick.addEventListener('click', () => setOpacity(v));
    ticks.appendChild(tick);
  });
  slider.addEventListener('input', () => {
    setOpacity(+slider.value);
  });
  // A value saved off the 10 % grid (an older build) moves to the nearest step.
  if (Number.isFinite(widget.config[key])) {
    widget.config[key] = Math.round(widget.config[key] / WIDGET_OPACITY_STEP) * WIDGET_OPACITY_STEP;
  }
  showOpacity(Number.isFinite(widget.config[key]) ? widget.config[key] : defaultValue);
  sliderWrap.appendChild(slider);
  sliderWrap.appendChild(ticks);
  return buildConfigRow(t('cfg.opacity'), [sliderWrap, value]);
}

function buildBackgroundSection(widget, defaultOn) {
  const body = document.createElement('div');

  body.appendChild(buildColorRow(widget, 'bgColor', WIDGET_BG_DEFAULT_COLOR, t('cfg.bgColor')));

  body.appendChild(buildOpacityRow(widget, 'bgOpacity', WIDGET_BG_DEFAULT_OPACITY));

  return buildToggleSection(widget, 'showBackground', t('cfg.background'), body, defaultOn);
}

// ── Fade-in length ──
const FADE_IN_DEFAULT_SECONDS = 3;
const FADE_IN_MIN_SECONDS = 0.5;
const FADE_IN_MAX_SECONDS = 10;

function fadeInSeconds(config) {
  const s = config.fadeInSeconds;
  return Number.isFinite(s) ? Math.min(Math.max(s, FADE_IN_MIN_SECONDS), FADE_IN_MAX_SECONDS) : FADE_IN_DEFAULT_SECONDS;
}

function buildFadeInSection(widget) {
  const body = document.createElement('div');
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'widget-config-number';
  input.min = FADE_IN_MIN_SECONDS;
  input.max = FADE_IN_MAX_SECONDS;
  input.step = '0.5';
  input.value = fadeInSeconds(widget.config);
  input.setAttribute('aria-label', t('cfg.fadeStart'));
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    widget.config.fadeInSeconds = Math.min(Math.max(v, FADE_IN_MIN_SECONDS), FADE_IN_MAX_SECONDS);
    drawOverlayPreview();
    state.scheduleSaveWidgetLayout();
  });
  // Shows the clamped value once the field is left, so it never displays one that is not used.
  input.addEventListener('change', () => { input.value = fadeInSeconds(widget.config); });
  const unit = document.createElement('span');
  unit.textContent = t('cfg.secondsBeforeExit');
  body.appendChild(buildConfigRow(t('cfg.fadeStart'), [input, unit]));
  return buildToggleSection(widget, 'fadeIn', t('cfg.fadeIn'), body);
}

// ── Shared graph helper: last index the graph widgets plot ──
// state.currentFlightData runs to landing + 5 s; the Alt. Graph and Speed Graph
// stop at fd.graphEndIdx (canopy + 5 s) so freefall keeps most of their width.
function graphEndIndex(fd) {
  const last = fd.times.length - 1;
  return Number.isInteger(fd.graphEndIdx) ? Math.max(0, Math.min(fd.graphEndIdx, last)) : last;
}

// ── Shared graph helper: current-value label beside the moving dot ──
// Always directly right of the dot, vertically centred on it, so it travels with the dot
// without ever jumping sides.
function drawGraphValueLabel(ctx, text, mx, my, h, effectiveScale) {
  const fontSize = h * 0.0975;
  ctx.save();
  ctx.font = '700 ' + fontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = fontSize * 0.3;
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(text, mx + 6 * effectiveScale, my);
  ctx.restore();
}

// ── Widget type registry ──
// configUI wrappers pass drawOverlayPreview and buildUnitsConfig to each widget's config builder
const WIDGET_TYPES = {
  info: {
    label: 'Info',
    defaultConfig: { showTime: true, showAltitude: true, showSpeed: true, showHSpeed: true, showDiveAngle: true, showScore: true, showBackground: true, showShadow: true, units: 'both', fadeIn: true },
    render: renderInfoWidget,
    renderPreview: renderInfoPreviewCard,
    configUI: (widget) => buildInfoConfigPanel(widget, drawOverlayPreview, buildUnitsConfig),
  },
  score: {
    label: 'Score',
    defaultConfig: { showLabel: true, showBackground: true, units: 'both', fadeIn: false },
    render: renderScoreWidget,
    renderPreview: renderScorePreviewCard,
    configUI: (widget) => buildScoreConfigPanel(widget, drawOverlayPreview, buildUnitsConfig),
  },
  vertSpeed: {
    label: 'Vert. Speed',
    defaultConfig: { dataSource: 'vertSpeed', units: 'metric', fadeIn: true, showBackground: false, showShadow: true, showLabel: false },
    render: renderSpeedWidget,
    renderPreview: renderVertSpeedPreviewCard,
    configUI: (widget) => buildSpeedConfigPanel(widget, drawOverlayPreview, buildUnitsConfig),
  },
  horzSpeed: {
    label: 'Horiz. Speed',
    defaultConfig: { dataSource: 'horzSpeed', units: 'metric', fadeIn: true, showBackground: false, showShadow: true, showLabel: false },
    render: renderSpeedWidget,
    renderPreview: renderHorzSpeedPreviewCard,
    configUI: (widget) => buildSpeedConfigPanel(widget, drawOverlayPreview, buildUnitsConfig),
  },
  altGraph: {
    label: 'Alt. Graph',
    defaultConfig: { showMeasuringZone: true, showScoringZone: true, showLabel: false, showValue: false, units: 'metric', showBackground: false, fadeIn: true },
    render: renderAltGraphWidget,
    renderPreview: renderAltGraphPreviewCard,
    configUI: (widget) => buildAltGraphConfigPanel(widget, drawOverlayPreview, buildUnitsConfig),
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
    defaultConfig: { showMeasuringZone: true, showScoringZone: true, showLabel: false, showValue: false, units: 'metric', showBackground: false, fadeIn: true },
    render: renderSpeedGraphWidget,
    renderPreview: renderSpeedGraphPreviewCard,
    configUI: (widget) => buildSpeedGraphConfigPanel(widget, drawOverlayPreview, buildUnitsConfig),
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
    defaultConfig: { showBackground: false, showShadow: true, showLabel: false, fadeIn: true },
    render: renderGForceWidget,
    renderPreview: renderGForcePreviewCard,
    configUI: (widget) => buildGForceConfigPanel(widget, drawOverlayPreview),
  },
  image: {
    label: 'Image',
    defaultConfig: { fadeIn: false, imageOpacity: 100 },
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
  const secs = fadeInSeconds(widget.config);
  if (t < -secs) return 0;
  if (t < 0) return (t + secs) / secs;
  return 1;
}

// ── Widget selection handles ──
// Trash can outline on a 24-unit grid: lid, handle, tapered bin, two slats.
// Shared with the jump list's delete button (TRASH_ICON_SVG in main.js), so
// both delete controls show the same icon.
const TRASH_ICON_PATH = 'M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6';

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

  // White trash can, the same icon as the jump list's delete button: the 24-unit
  // path scaled to 12 px and centred in the circle.
  const iconSize = 12;
  ctx.translate(delX + (delSize - iconSize) / 2, delY + (delSize - iconSize) / 2);
  ctx.scale(iconSize / 24, iconSize / 24);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3; // in path units, so 1.5 px on screen
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(TRASH_ICON_PATH));

  ctx.restore();
}

// ── Widget hit-testing ──
function hitTestWidgets(canvasX, canvasY, contentRect) {
  if (state.videoExitTime === null) return null;
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

  // Selecting a widget on the video opens step card 2 (Add widgets); its settings
  // show under the timeline. Also keeps the card's widget count current, since
  // every add/remove ends here.
  if (state.selectedWidgetId !== null && state.videoExitTime !== null) state.videoStep = 2;
  if (typeof refreshVideoSteps === 'function') refreshVideoSteps();

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

  // Widgets can only show this jump's data once the exit is synced, so they
  // stay hidden until then (hitTestWidgets() skips them too).
  if (state.videoExitTime === null) return;

  const dataIdx = videoTimeToDataIndex(video.currentTime);

  ctx.save();
  ctx.translate(rect.offX, rect.offY);
  // isPreview marks editor-only drawing (the hidden Score widget's dashed placeholder);
  // the export builds its own contentRect without it.
  const contentRect = { width: rect.contentW, height: rect.contentH, isPreview: true };

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
