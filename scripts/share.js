// ── Share the chart as an image ──
// The share button in the chart header opens a small menu: pick "Chart only"
// or "Chart with stats", then Download PNG, Copy image, or (where the browser
// can share files) the system share sheet. The Season overview has the same
// button and menu, without the layout choice (buildSeasonShareCanvas()).
//
// The image is drawn on a canvas, with no screenshot library: the live chart
// captured at 2x (whatever preset, zoom and series are on screen), a header
// with the jump name and start time, optionally a stats panel built from
// state.currentJumpStats (published by renderCurrentJump()), and a small
// FlySight Insights footer. Colours follow the active theme and the labels the
// active language, unlike the video overlay, whose output never changes.

const SHARE_LAYOUT_KEY = 'flysight_share_layout';
const SHARE_SCALE = 2;
const SHARE_FONT = "'Segoe UI', system-ui, sans-serif";
const SHARE_PAD = 24;
const SHARE_HEADER_H = 58;
const SHARE_FOOTER_H = 40;
const SHARE_PANEL_W = 270;
const SHARE_PANEL_GAP = 28;
const SHARE_GREEN = '#4ade80';
const SHARE_RED = '#ef4444';

// The chart's canvas, redrawn at SHARE_SCALE pixels per CSS pixel (or the
// screen's own ratio, if higher) and copied. The hover tooltip and crosshair
// are cleared first so they don't end up in the picture, and the legend leaves
// out the hidden series: on screen they stay listed, struck through, so they
// can be clicked back on, but in a shared image they are only clutter.
// resize() only redraws when the pixel ratio actually changes, so update()
// is called as well to rebuild the legend on a screen that is already 2x.
function captureChartCanvas(chart) {
  if (!chart) return null;
  chart.setActiveElements([]);
  if (chart.tooltip) chart.tooltip.setActiveElements([], { x: 0, y: 0 });
  const legendLabels = chart.options.plugins.legend.labels;
  const prevFilter = legendLabels.filter;
  const prevRatio = chart.options.devicePixelRatio;
  legendLabels.filter = item => !item.hidden;
  chart.options.devicePixelRatio = Math.max(SHARE_SCALE, window.devicePixelRatio || 1);
  chart.resize();
  chart.update('none');
  const copy = document.createElement('canvas');
  copy.width = chart.canvas.width;
  copy.height = chart.canvas.height;
  copy.getContext('2d').drawImage(chart.canvas, 0, 0);
  const shot = { canvas: copy, w: chart.width, h: chart.height };
  legendLabels.filter = prevFilter;
  chart.options.devicePixelRatio = prevRatio;
  chart.resize();
  chart.update('none');
  return shot;
}

function shareColors() {
  const c = (name, fallback) => getThemeColor(name) || fallback;
  return {
    bg: c('bg-card', '#1e293b'),
    border: c('border', '#334155'),
    strong: c('text-strong', '#f8fafc'),
    text: c('text', '#e2e8f0'),
    muted: c('text-muted', '#94a3b8'),
    dim: c('text-dim', '#64748b'),
    accent: c('accent', '#38bdf8')
  };
}

// Text that shrinks until it fits `maxW` (a long translation in the panel).
function fillFitText(ctx, text, x, y, maxW, size, weight) {
  let s = size;
  ctx.font = `${weight} ${s}px ${SHARE_FONT}`;
  while (s > 8 && ctx.measureText(text).width > maxW) {
    s -= 0.5;
    ctx.font = `${weight} ${s}px ${SHARE_FONT}`;
  }
  ctx.fillText(text, x, y);
}

function setLetterSpacing(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px';
}

const fmtM = m => `${m.toFixed(0)} m / ${(m * 3.28084).toFixed(0)} ft`;

// The stats panel: the same figures, labels and order as the stat cards.
// Draws from `y` and returns where it ended; with `dry` it only measures, so
// the canvas can be sized before anything is drawn.
function drawShareStats(ctx, s, x, y, col, dry) {
  const W = SHARE_PANEL_W;
  const label = text => {
    if (!dry) {
      ctx.fillStyle = col.muted;
      setLetterSpacing(ctx, 0.6);
      fillFitText(ctx, text.toUpperCase(), x, y + 11, W, 11, 400);
      setLetterSpacing(ctx, 0);
    }
    y += 18;
  };
  const value = (text, color, size = 16) => {
    if (!dry) {
      ctx.fillStyle = color;
      fillFitText(ctx, text, x, y + size - 2, W, size, 600);
    }
    y += size + 6;
  };
  // A small uppercase caption followed by a value on the same line.
  const detail = (caption, text, color) => {
    if (!dry) {
      ctx.font = `400 10.5px ${SHARE_FONT}`;
      setLetterSpacing(ctx, 0.4);
      const cap = caption.toUpperCase() + '  ';
      ctx.fillStyle = col.muted;
      ctx.fillText(cap, x, y + 13);
      const capW = ctx.measureText(cap).width;
      setLetterSpacing(ctx, 0);
      ctx.fillStyle = color;
      fillFitText(ctx, text, x + capW, y + 13, W - capW, 14, 600);
    }
    y += 21;
  };
  const gap = () => { y += 14; };

  if (s.speedScore !== null) {
    label(t('stat.speedScore'));
    if (!dry) {
      ctx.fillStyle = col.accent;
      ctx.font = `700 36px ${SHARE_FONT}`;
      const num = s.speedScore.toFixed(2);
      ctx.fillText(num, x, y + 33);
      const numW = ctx.measureText(num).width;
      ctx.font = `600 15px ${SHARE_FONT}`;
      ctx.fillText(' km/h', x + numW, y + 33);
    }
    y += 44;
    gap();
  }

  label(t('stat.exitAltitude'));
  value(fmtM(s.exitAglM), s.exitValid ? SHARE_GREEN : SHARE_RED);
  if (!s.exitValid) {
    // The verdict half of "<verdict> — <limit>", as on the card's warning.
    const verdict = s.exitMessage.split(/\s*—\s*/)[0];
    value(verdict, SHARE_RED, 12);
  }
  gap();

  label(t('stat.maxVertSpeed'));
  value(`${s.maxVertKmh.toFixed(0)} km/h / ${(s.maxVertKmh / 1.609344).toFixed(0)} mph`, col.accent);
  gap();

  if (s.windowStartAglM !== null || s.windowEndAglM !== null) {
    label(t('stat.speedWindow'));
    detail(t('stat.start'), s.windowStartAglM !== null ? fmtM(s.windowStartAglM) : '—', col.accent);
    if (s.windowEndAglM !== null) detail(t('stat.end'), fmtM(s.windowEndAglM), col.accent);
    gap();
  }

  if (s.avgAccelExitToEnd !== null || s.avgAccelBest3s !== null || s.maxSAcc !== null) {
    label(t('stat.avgAccelDown'));
    if (s.avgAccelExitToEnd !== null) detail(t('stat.accelExitToEnd'), s.avgAccelExitToEnd.toFixed(2) + ' m/s²', col.accent);
    if (s.avgAccelBest3s !== null) detail(t('stat.accelBest3s'), s.avgAccelBest3s.toFixed(2) + ' m/s²', col.accent);
    if (s.maxSAcc !== null) detail(t('stat.maxSpeedAcc'), s.maxSAcc.toFixed(2) + ' m/s', s.accValid ? SHARE_GREEN : SHARE_RED);
    gap();
  }

  if (s.windKmh !== null) {
    label(t('stat.exitWindAir'));
    detail(t('stat.wind'), `${s.windKmh.toFixed(0)} km/h ${t('stat.windFrom', { deg: s.windFromDeg.toFixed(0) })}`, col.accent);
    detail(t('stat.air'), s.airKmh.toFixed(0) + ' km/h', col.accent);
    gap();
  }
  return y - 14;
}

// The FlySight Insights footer: the logo silhouette (FAVICON_PATH, 30 x 80
// viewBox) in the accent colour, then the app name.
function drawShareFooter(ctx, x, baseline, col) {
  const h = 20, scale = h / 80;
  ctx.save();
  ctx.translate(x - 7 * scale, baseline - h + 3);
  ctx.scale(scale, scale);
  ctx.fillStyle = col.accent;
  ctx.fill(new Path2D(FAVICON_PATH));
  ctx.restore();
  ctx.fillStyle = col.muted;
  ctx.font = `600 13px ${SHARE_FONT}`;
  ctx.fillText('FlySight Insights', x + 14, baseline);
}

// A title line and a smaller line beneath it, at the top of the image.
function drawShareHeader(ctx, title, subtitle, W, col) {
  ctx.fillStyle = col.strong;
  fillFitText(ctx, title, SHARE_PAD, SHARE_PAD + 20, W - SHARE_PAD * 2, 21, 600);
  ctx.fillStyle = col.muted;
  ctx.font = `400 13px ${SHARE_FONT}`;
  ctx.fillText(subtitle, SHARE_PAD, SHARE_PAD + 42);
}

// A canvas of W x H CSS pixels, drawn at SHARE_SCALE, filled with the card colour.
function newShareCanvas(W, H, col) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * SHARE_SCALE);
  canvas.height = Math.round(H * SHARE_SCALE);
  const ctx = canvas.getContext('2d');
  ctx.scale(SHARE_SCALE, SHARE_SCALE);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = col.bg;
  ctx.fillRect(0, 0, W, H);
  return { canvas, ctx };
}

// Draws the whole image. `layout` is 'chart' or 'stats'. Null when no jump is shown.
function buildShareCanvas(layout) {
  const s = state.currentJumpStats;
  const shot = captureChartCanvas(state.chartInstance);
  if (!shot || !s) return null;
  const col = shareColors();
  const withStats = layout === 'stats';

  const measure = document.createElement('canvas').getContext('2d');
  const panelH = withStats ? drawShareStats(measure, s, 0, 0, col, true) : 0;
  const contentH = Math.max(shot.h, panelH);
  const W = SHARE_PAD * 2 + shot.w + (withStats ? SHARE_PANEL_GAP + SHARE_PANEL_W : 0);
  const H = SHARE_PAD + SHARE_HEADER_H + contentH + SHARE_FOOTER_H;

  const { canvas, ctx } = newShareCanvas(W, H, col);

  // Header: the jump name, then the UTC start beneath it.
  drawShareHeader(ctx, s.name, `${s.utcDate} ${s.utcTime}`, W, col);

  const top = SHARE_PAD + SHARE_HEADER_H;
  ctx.drawImage(shot.canvas, SHARE_PAD, top, shot.w, shot.h);

  if (withStats) {
    const lineX = SHARE_PAD + shot.w + SHARE_PANEL_GAP / 2;
    ctx.strokeStyle = col.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lineX + 0.5, top);
    ctx.lineTo(lineX + 0.5, top + contentH);
    ctx.stroke();
    drawShareStats(ctx, s, SHARE_PAD + shot.w + SHARE_PANEL_GAP, top, col, false);
  }

  drawShareFooter(ctx, SHARE_PAD, H - SHARE_PAD + 4, col);
  return canvas;
}

// ── Season overview image ──
const SHARE_LEGEND_ROW_H = 22;
const SHARE_LEGEND_GAP = 20;

// The season legend under the graph: the items that are switched on, as on
// screen (seasonLegendItems() in season.js), wrapped onto as many rows as
// `maxW` needs. Returns the height used; with `dry` it only measures.
function drawSeasonShareLegend(ctx, items, x, y, maxW, col, dry) {
  ctx.font = `400 12.5px ${SHARE_FONT}`;
  let cx = x, rows = 1;
  items.forEach(it => {
    const swW = it.kind === 'dot' ? 10 : 16;
    const w = swW + 6 + ctx.measureText(it.text).width;
    if (cx > x && cx + w > x + maxW) { cx = x; rows++; }
    const mid = y + (rows - 1) * SHARE_LEGEND_ROW_H + 11;
    if (!dry) {
      ctx.fillStyle = it.color;
      ctx.strokeStyle = it.color;
      if (it.kind === 'dot') {
        ctx.beginPath();
        ctx.arc(cx + 5, mid, 5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.lineWidth = 2;
        ctx.setLineDash(it.kind === 'dash' ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(cx, mid);
        ctx.lineTo(cx + swW, mid);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = col.muted;
      ctx.fillText(it.text, cx + swW + 6, mid + 4.5);
    }
    cx += w + SHARE_LEGEND_GAP;
  });
  return items.length ? rows * SHARE_LEGEND_ROW_H : 0;
}

// The Season overview as shown: title and tab, the jump count, the graph and
// the switched-on legend items. Null when the tab has no graph.
function buildSeasonShareCanvas() {
  const shot = captureChartCanvas(seasonChart);
  if (!shot) return null;
  const col = shareColors();
  const items = seasonLegendItems().filter(it => !it.off);
  const W = SHARE_PAD * 2 + shot.w;
  const measure = document.createElement('canvas').getContext('2d');
  const legendH = drawSeasonShareLegend(measure, items, 0, 0, shot.w, col, true);
  const H = SHARE_PAD + SHARE_HEADER_H + shot.h + (legendH ? 12 + legendH + 12 : 0) + SHARE_FOOTER_H;
  const { canvas, ctx } = newShareCanvas(W, H, col);

  drawShareHeader(ctx, t('season.title') + ' · ' + seasonTabLabel(),
    t('season.summary', { count: seasonEntries.length }), W, col);
  const top = SHARE_PAD + SHARE_HEADER_H;
  ctx.drawImage(shot.canvas, SHARE_PAD, top, shot.w, shot.h);
  if (legendH) drawSeasonShareLegend(ctx, items, SHARE_PAD, top + shot.h + 12, shot.w, col, false);
  drawShareFooter(ctx, SHARE_PAD, H - SHARE_PAD + 4, col);
  return canvas;
}

function sharePngBlob(build) {
  return new Promise((resolve, reject) => {
    const canvas = build();
    if (!canvas) { reject(new Error('Nothing to share')); return; }
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encoding failed')), 'image/png');
  });
}

// "<name>.png", with the characters Windows refuses in a filename replaced.
function sharePngName(name) {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') + '.png';
}

// ── Menu ──
function readShareLayout() {
  try { return localStorage.getItem(SHARE_LAYOUT_KEY) === 'chart' ? 'chart' : 'stats'; }
  catch (e) { return 'stats'; }
}

function selectedShareLayout() {
  const checked = document.querySelector('input[name="shareLayout"]:checked');
  return checked ? checked.value : 'stats';
}

function canShareFiles() {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [new File([''], 'x.png', { type: 'image/png' })] });
  } catch (e) { return false; }
}

// Wires one share button and its menu. `prefix` names the elements
// (<prefix>Wrap, <prefix>Btn, <prefix>Menu, <prefix>DownloadBtn, ...);
// `build` draws the image and `filename` names it. Returns the close function.
function initShareMenu(prefix, { build, filename, onOpen }) {
  const el = suffix => document.getElementById(prefix + suffix);
  const wrap = el('Wrap');
  if (!wrap) return () => {};
  const btn = el('Btn'), menu = el('Menu');
  const copyBtn = el('CopyBtn'), nativeBtn = el('NativeBtn');

  const open = () => {
    if (onOpen) onOpen();
    copyBtn.hidden = !(navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem === 'function');
    nativeBtn.hidden = !canShareFiles();
    menu.hidden = false;
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    menu.hidden = true;
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.hidden) open(); else close();
  });
  el('DownloadBtn').addEventListener('click', async () => {
    try {
      saveBlob(await sharePngBlob(build), filename());
      close();
    } catch (e) {
      console.error('Share image failed', e);
      alert(t('share.failed', { error: e.message || e }));
    }
  });
  copyBtn.addEventListener('click', async () => {
    try {
      // The ClipboardItem gets the promise, not the blob: Safari only allows the
      // write while the click's activation is fresh, and drawing takes a moment.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': sharePngBlob(build) })]);
      copyBtn.textContent = t('share.copied');
      setTimeout(() => {
        copyBtn.textContent = t('share.copy');
        close();
      }, 1200);
    } catch (e) {
      console.error('Copy image failed', e);
      alert(t('share.copyFailed'));
    }
  });
  nativeBtn.addEventListener('click', async () => {
    try {
      const blob = await sharePngBlob(build);
      await navigator.share({ files: [new File([blob], filename(), { type: 'image/png' })] });
      close();
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // the user closed the share sheet
      console.error('Share failed', e);
      alert(t('share.failed', { error: e.message || e }));
    }
  });
  document.addEventListener('mousedown', e => {
    if (!menu.hidden && !wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) close();
  });
  return close;
}

// The chart header's menu, with its "Chart only" / "Chart with stats" choice.
initShareMenu('share', {
  build: () => buildShareCanvas(selectedShareLayout()),
  filename: () => sharePngName(((state.currentJumpStats && state.currentJumpStats.name) || 'jump') + ' chart'),
  onOpen: () => {
    const layout = readShareLayout();
    document.querySelectorAll('input[name="shareLayout"]').forEach(r => { r.checked = r.value === layout; });
  }
});
document.querySelectorAll('input[name="shareLayout"]').forEach(r => r.addEventListener('change', () => {
  try { localStorage.setItem(SHARE_LAYOUT_KEY, r.value); } catch (e) { /* ignore */ }
}));

// The Season overview's menu. closeSeasonModal() and the season Escape
// handler call closeSeasonShareMenu().
const closeSeasonShareMenu = initShareMenu('seasonShare', {
  build: buildSeasonShareCanvas,
  filename: () => sharePngName(t('season.title') + ' ' + seasonTabLabel())
});
