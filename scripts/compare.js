
// ── Compare Jumps modal ──
// Overlays the GPS trajectory of multiple stored jumps onto a single map.
// Each track shows just the jump portion: 5 s before exit through canopy + 5 s.

// Golden angle spacing in degrees — produces evenly distributed hues for any
// number of jumps so no two tracks ever share a color.
const HUE_GOLDEN_ANGLE = 137.508;

state.compareSelected = new Set();
state.compareDataCache = new Map();
state.compareMapInstance = null;
state.compareJumpColors = new Map(); // name -> hsl color, rebuilt on each list render
// Random hue offset, stable for the session so colors don't flicker between
// re-opens but feel different each page load.
state.compareHueOffset = Math.random() * 360;
state.compareActiveView = 'topMap'; // topMap | view3d | vertSpeedTable | diveAngleTable
state.compare3dCamera = { yaw: 35, pitch: 25, zoom: 1, panX: 0, panY: 0 };
// Cached satellite texture for the 3D ground plane: { key, canvas, bounds }
state.compareGroundTexture = null;
state.compareGroundLoading = null; // string key currently loading, to dedupe
// Hover state for 3D tooltip: { name, idx } | null. Updated by mousemove
// hit-tests against the cached projected screen positions.
state.compare3dHover = null;
state.compare3dProjected = []; // [{ name, color, screen: [[x,y], ...] }] — refreshed every render
// Auto-rotate animation state. Driven by requestAnimationFrame; rAF handle
// kept so we can cancel cleanly on stop / view-switch / modal-close.
state.compare3dAnimating = false;
state.compare3dRafId = null;
state.compare3dLastFrameTs = 0;
// Default-on behaviour: rotation auto-starts when the user enters the 3D
// view, unless they have explicitly paused it during this modal session.
// Reset on modal open. Clicking the rotate button toggles this flag.
state.compare3dRotateUserPaused = false;
const COMPARE_3D_AUTO_ROTATE_DEG_PER_SEC = 10;

// Time scrubber represents an ABSOLUTE wall-clock instant, in ms since
// epoch. Each jump computes its own elapsed seconds = (scrubMs - exitMs)/1000
// and is truncated to points where times[i] <= elapsed. The slider always
// shows in the 3D view; user drives it manually (no auto-advance).
//   scrubMin = earliest exit timestamp across selected jumps
//   scrubMax = latest "under-canopy" timestamp across selected jumps
//   scrubMs  = current slider position (defaults to scrubMax, i.e. 100%)
state.compare3dScrubMin = 0;
state.compare3dScrubMax = 0;
state.compare3dScrubMs = 0;
// Clip recording state. While recording, scrubMs is driven by an rAF loop
// that linearly advances from scrubMin to scrubMax over the chosen duration,
// then holds at 100% for COMPARE_CLIP_TAIL_SEC before stopping the recorder.
state.compareClipRecording = false;
state.compareClipRafId = null;
state.compareClipRecorder = null;
const COMPARE_CLIP_TAIL_SEC = 3;

const COMPARE_TABLE_TIMES = [0, 5, 10, 15, 20, 25, 30];

function rebuildCompareColorMap(jumps) {
  state.compareJumpColors = new Map();
  jumps.forEach((j, i) => {
    const hue = (state.compareHueOffset + i * HUE_GOLDEN_ANGLE) % 360;
    state.compareJumpColors.set(j.name, 'hsl(' + hue.toFixed(1) + ', 75%, 62%)');
  });
}

function compareJumpColor(name) {
  return state.compareJumpColors.get(name) || '#38bdf8';
}

function buildCompareJumpData(jump) {
  const data = parseFlySightCSV(jump.csv);
  if (!data || data.length < 50) return null;

  const firstT = parseTimestamp(data[0].time);
  const allTimes = data.map(r => (parseTimestamp(r.time) - firstT) / 1000);

  const det = detectExitAndLanding(data);
  if (!det) return null;
  const { exitIdx, canopyIdx } = det;
  if (exitIdx == null || canopyIdx == null || canopyIdx <= exitIdx) return null;

  const exitTime = allTimes[exitIdx];
  const canopyTime = allTimes[canopyIdx];

  const beforeSec = 5;
  const afterSec = 5;
  let startIdx = allTimes.findIndex(t => t >= exitTime - beforeSec);
  let endIdx = allTimes.findIndex(t => t >= canopyTime + afterSec);
  if (startIdx < 0) startIdx = 0;
  if (endIdx < 0) endIdx = data.length - 1;

  const path = [];
  const times = [];      // seconds relative to exit
  const alts = [];       // metres MSL
  const vertSpeeds = []; // km/h (positive down)
  const diveAngles = []; // degrees, null when horizontal speed is 0
  for (let i = startIdx; i <= endIdx; i++) {
    const lat = parseFloat(data[i].lat);
    const lon = parseFloat(data[i].lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    path.push([lat, lon]);
    const tRel = allTimes[i] - exitTime;
    times.push(tRel);
    alts.push(parseFloat(data[i].hMSL));
    const vN = parseFloat(data[i].velN) || 0;
    const vE = parseFloat(data[i].velE) || 0;
    const vD = parseFloat(data[i].velD);
    const hSpd = Math.sqrt(vN * vN + vE * vE);
    vertSpeeds.push(isFinite(vD) ? vD * 3.6 : null);
    diveAngles.push(isFinite(vD) && hSpd > 0
      ? Math.atan2(vD, hSpd) * 180 / Math.PI
      : null);
  }
  if (path.length < 2) return null;

  const exitLat = parseFloat(data[exitIdx].lat);
  const exitLon = parseFloat(data[exitIdx].lon);
  const canopyLat = parseFloat(data[canopyIdx].lat);
  const canopyLon = parseFloat(data[canopyIdx].lon);
  const exitPos = isFinite(exitLat) && isFinite(exitLon) ? [exitLat, exitLon] : null;
  const canopyPos = isFinite(canopyLat) && isFinite(canopyLon) ? [canopyLat, canopyLon] : null;

  // Airplane heading line: from the GPS displacement during the 3 s leading
  // up to exit, extended ±8× in both directions for visibility. Mirrors the
  // implementation in scripts/chart.js renderMap().
  let headingLine = null;
  let headingRefIdx = exitIdx;
  for (let i = exitIdx; i >= 0; i--) {
    if (exitTime - allTimes[i] >= 3) { headingRefIdx = i; break; }
  }
  if (headingRefIdx !== exitIdx && exitPos) {
    const refLat = parseFloat(data[headingRefIdx].lat);
    const refLon = parseFloat(data[headingRefIdx].lon);
    if (isFinite(refLat) && isFinite(refLon)) {
      const dLat = exitLat - refLat;
      const dLon = exitLon - refLon;
      const extendFactor = 8;
      headingLine = [
        [exitLat - dLat * extendFactor, exitLon - dLon * extendFactor],
        [exitLat + dLat * extendFactor, exitLon + dLon * extendFactor]
      ];
    }
  }

  return {
    path, exitPos, canopyPos, headingLine,
    times, alts, vertSpeeds, diveAngles,
    canopyTimeRel: allTimes[canopyIdx] - exitTime,
    // Absolute wall-clock timestamp (ms since epoch) of the exit moment.
    // Used by the 3D scrubber, which represents true datetime across jumps.
    exitTimestampMs: firstT + exitTime * 1000,
  };
}

function getCompareData(jump) {
  if (state.compareDataCache.has(jump.name)) {
    return state.compareDataCache.get(jump.name);
  }
  const built = buildCompareJumpData(jump);
  state.compareDataCache.set(jump.name, built);
  return built;
}

async function openCompareModal() {
  document.getElementById('compareModal').classList.add('open');
  // Fresh modal session — clear the manual-pause memory so rotation auto-
  // starts on the first 3D view entry.
  state.compare3dRotateUserPaused = false;
  await renderCompareJumpsList();
  renderCompareView();
  // If the modal reopens on the 3D view (e.g. user closed and reopened),
  // setCompareView won't run its view-enter logic, so kick off rotation here.
  if (state.compareActiveView === 'view3d' && !state.compare3dAnimating) {
    startCompare3dAnimation();
  }
}

function closeCompareModal() {
  document.getElementById('compareModal').classList.remove('open');
  if (state.compareMapInstance) {
    state.compareMapInstance.remove();
    state.compareMapInstance = null;
  }
  if (state.compare3dAnimating) stopCompare3dAnimation();
  if (state.compareClipRecording) abortCompareClip();
}

function setCompareView(view) {
  if (state.compareActiveView === view) return;
  state.compareActiveView = view;
  document.querySelectorAll('.compare-view-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  document.querySelectorAll('.compare-view').forEach(v => {
    v.hidden = v.dataset.view !== view;
  });
  // Leave the map alone when hidden — Leaflet doesn't like rendering into a
  // detached container; we destroy it on switch-away and rebuild on return.
  if (view !== 'topMap' && state.compareMapInstance) {
    state.compareMapInstance.remove();
    state.compareMapInstance = null;
  }
  if (view !== 'view3d') {
    state.compare3dHover = null;
    const tooltip = document.getElementById('compare3dTooltip');
    if (tooltip) tooltip.hidden = true;
    if (state.compare3dAnimating) stopCompare3dAnimation();
    if (state.compareClipRecording) abortCompareClip();
  } else {
    refreshCompare3dScrub();
    if (!state.compare3dAnimating && !state.compare3dRotateUserPaused) {
      startCompare3dAnimation();
    }
  }
  renderCompareView();
}

function renderCompareView() {
  // Empty-state placeholder is shared across all four views.
  const emptyEl = document.getElementById('compareEmpty');
  const hasSelection = state.compareSelected.size > 0
    && Array.from(state.compareSelected).some(n => state.compareDataCache.get(n));
  if (!hasSelection) {
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
  }

  switch (state.compareActiveView) {
    case 'view3d': renderCompare3d(); break;
    case 'vertSpeedTable': renderCompareTable('vertSpeeds', 'km/h', 1); break;
    case 'diveAngleTable': renderCompareTable('diveAngles', '°', 1); break;
    case 'topMap':
    default: renderCompareMap(); break;
  }
}

async function renderCompareJumpsList() {
  const listEl = document.getElementById('compareJumpsList');
  const jumps = await getStoredJumps();
  rebuildCompareColorMap(jumps);

  let scores = {};
  try { scores = JSON.parse(localStorage.getItem('flysight_scores') || '{}'); } catch (e) {}

  // Default: pre-select all jumps that have valid data. Triggers on first
  // open and whenever the selection has been emptied (e.g. user unchecked
  // everything and reopened).
  if (state.compareSelected.size === 0) {
    jumps.forEach(j => {
      if (getCompareData(j) !== null) state.compareSelected.add(j.name);
    });
  }

  // Drop selections for jumps that no longer exist.
  const liveNames = new Set(jumps.map(j => j.name));
  for (const name of Array.from(state.compareSelected)) {
    if (!liveNames.has(name)) state.compareSelected.delete(name);
  }

  listEl.innerHTML = '';
  if (jumps.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'compare-jump-row disabled';
    empty.innerHTML = '<span class="compare-jump-name">No jumps loaded.</span>';
    listEl.appendChild(empty);
    return;
  }

  jumps.forEach(j => {
    const isSelected = state.compareSelected.has(j.name);
    const built = getCompareData(j);
    const row = document.createElement('label');
    row.className = 'compare-jump-row' + (built === null ? ' disabled' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = isSelected && built !== null;
    cb.disabled = built === null;
    cb.addEventListener('change', () => {
      if (cb.checked) state.compareSelected.add(j.name);
      else state.compareSelected.delete(j.name);
      if (state.compareActiveView === 'view3d') refreshCompare3dScrub();
      renderCompareView();
      const swatch = row.querySelector('.compare-color-swatch');
      if (swatch) {
        if (cb.checked) {
          swatch.style.background = compareJumpColor(j.name);
          swatch.classList.remove('empty');
        } else {
          swatch.style.background = '';
          swatch.classList.add('empty');
        }
      }
    });

    const swatch = document.createElement('span');
    swatch.className = 'compare-color-swatch' + (isSelected && built !== null ? '' : ' empty');
    if (isSelected && built !== null) swatch.style.background = compareJumpColor(j.name);

    const name = document.createElement('span');
    name.className = 'compare-jump-name';
    const score = scores[j.name];
    const baseName = built === null ? j.name + ' (insufficient data)' : j.name;
    if (score && built !== null) {
      name.textContent = baseName + ' ';
      const scoreEl = document.createElement('span');
      scoreEl.className = 'score';
      scoreEl.textContent = '(' + score.toFixed(1) + ' km/h)';
      name.appendChild(scoreEl);
    } else {
      name.textContent = baseName;
    }

    row.appendChild(cb);
    row.appendChild(swatch);
    row.appendChild(name);
    listEl.appendChild(row);
  });
}

function getSelectedCompareEntries() {
  const entries = [];
  Array.from(state.compareSelected).forEach(name => {
    const cached = state.compareDataCache.get(name);
    if (cached) entries.push({ name, data: cached });
  });
  return entries;
}

function renderCompareMap() {
  if (state.compareMapInstance) {
    state.compareMapInstance.remove();
    state.compareMapInstance = null;
  }

  const buildEntries = getSelectedCompareEntries();
  if (buildEntries.length === 0) return;

  const map = L.map('compareMap', { attributionControl: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19
  }).addTo(map);

  const boundsPoints = [];
  buildEntries.forEach(({ name, data }) => {
    const color = compareJumpColor(name);
    if (data.headingLine) {
      L.polyline(data.headingLine, {
        color: '#94a3b8',
        weight: 3,
        dashArray: '8, 8',
        opacity: 0.7
      }).addTo(map).bindTooltip(name + ' — airplane heading', { sticky: true });
    }
    L.polyline(data.path, {
      color,
      weight: 3,
      opacity: 0.9
    }).addTo(map).bindTooltip(name, { sticky: true });

    if (data.exitPos) {
      L.circleMarker(data.exitPos, {
        radius: 5,
        color: '#facc15',
        weight: 2,
        fillColor: color,
        fillOpacity: 1
      }).addTo(map).bindTooltip(name + ' — exit', { direction: 'top' });
    }
    if (data.canopyPos) {
      L.circleMarker(data.canopyPos, {
        radius: 4,
        color: '#94a3b8',
        weight: 1.5,
        fillColor: color,
        fillOpacity: 1
      }).addTo(map).bindTooltip(name + ' — canopy', { direction: 'top' });
    }
    data.path.forEach(p => boundsPoints.push(p));
  });

  if (boundsPoints.length) {
    map.fitBounds(boundsPoints, { padding: [20, 20] });
  }

  // Modal layout may not be flushed yet on first open; let Leaflet
  // recompute its container size once the browser has painted.
  setTimeout(() => map.invalidateSize(), 0);

  state.compareMapInstance = map;
}

// ── Vertical-speed / dive-angle table view ──
function interpolateAtTime(times, values, targetT) {
  if (!times.length) return null;
  if (targetT < times[0] || targetT > times[times.length - 1]) return null;
  for (let i = 1; i < times.length; i++) {
    if (times[i] >= targetT) {
      const t0 = times[i - 1], t1 = times[i];
      const v0 = values[i - 1], v1 = values[i];
      if (v0 == null || v1 == null) return null;
      if (t1 === t0) return v0;
      const f = (targetT - t0) / (t1 - t0);
      return v0 + (v1 - v0) * f;
    }
  }
  return null;
}

function renderCompareTable(field, unit, decimals) {
  const tableId = field === 'vertSpeeds' ? 'compareVertSpeedTable' : 'compareDiveAngleTable';
  const table = document.getElementById(tableId);
  table.innerHTML = '';

  const entries = getSelectedCompareEntries();
  if (!entries.length) return;

  // Pre-compute the value at each (jump, time) cell. The first jump in the
  // list acts as the baseline — every subsequent row shows its delta against
  // that row's value in the same column (stocks-style green/red tag). The
  // baseline row itself never shows a delta.
  const cellValues = entries.map(({ data }) =>
    COMPARE_TABLE_TIMES.map(t => interpolateAtTime(data.times, data[field], t))
  );
  const baselineRow = cellValues[0] || [];

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const jumpHead = document.createElement('th');
  jumpHead.textContent = 'Jump';
  headRow.appendChild(jumpHead);
  COMPARE_TABLE_TIMES.forEach(t => {
    const valueTh = document.createElement('th');
    valueTh.textContent = t + 's';
    valueTh.className = 'compare-value-col';
    headRow.appendChild(valueTh);
    const deltaTh = document.createElement('th');
    deltaTh.className = 'compare-delta-col';
    headRow.appendChild(deltaTh);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  entries.forEach(({ name }, rowIdx) => {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    const wrap = document.createElement('span');
    wrap.className = 'compare-row-name';
    const swatch = document.createElement('span');
    swatch.className = 'compare-color-swatch';
    swatch.style.background = compareJumpColor(name);
    wrap.appendChild(swatch);
    wrap.appendChild(document.createTextNode(name));
    nameTd.appendChild(wrap);
    tr.appendChild(nameTd);

    COMPARE_TABLE_TIMES.forEach((_, colIdx) => {
      const valueTd = document.createElement('td');
      valueTd.className = 'compare-value-col';
      const deltaTd = document.createElement('td');
      deltaTd.className = 'compare-delta-col';

      const v = cellValues[rowIdx][colIdx];
      if (v == null || isNaN(v)) {
        valueTd.textContent = '—';
        valueTd.classList.add('compare-empty-cell');
      } else {
        valueTd.textContent = v.toFixed(decimals) + (unit === '°' ? '°' : ' ' + unit);
        const baseline = baselineRow[colIdx];
        if (rowIdx > 0 && baseline != null && !isNaN(baseline)) {
          const delta = v - baseline;
          // Suppress essentially-zero deltas so the table doesn't get noisy
          // when a jump sits right on the baseline value.
          if (Math.abs(delta) >= Math.pow(10, -decimals) / 2) {
            const sign = delta > 0 ? '+' : '−';
            deltaTd.textContent = sign + Math.abs(delta).toFixed(decimals);
            deltaTd.classList.add(delta > 0 ? 'up' : 'down');
          }
        }
      }
      tr.appendChild(valueTd);
      tr.appendChild(deltaTd);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

// ── 3D ground texture: stitched satellite tiles ──
// Esri World Imagery (same source as the top map). We pick a zoom such that
// the wider dimension of the bbox is roughly 1024 px, fetch the tiles that
// cover the bbox, and stitch them onto an offscreen canvas. The canvas is
// then warped onto the 3D ground plane via an affine setTransform — valid
// because our projection is orthographic, so a flat plane maps to a
// parallelogram on screen.
const COMPARE_TILE_SIZE = 256;
const COMPARE_TILE_TARGET_PX = 1024;
const EARTH_EQUATOR_M = 40075016.686;

function compareLatLonToTile(lat, lon, z) {
  const n = Math.pow(2, z);
  const xt = (lon + 180) / 360 * n;
  const yt = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;
  return [xt, yt];
}
function compareTileToLatLon(xt, yt, z) {
  const n = Math.pow(2, z);
  const lon = xt / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yt / n))) * 180 / Math.PI;
  return [lat, lon];
}

function compareGroundKey(b) {
  return [b.minLat, b.maxLat, b.minLon, b.maxLon].map(n => n.toFixed(4)).join(',');
}

function loadCompareGroundTexture(b) {
  const key = compareGroundKey(b);
  if (state.compareGroundTexture && state.compareGroundTexture.key === key) {
    return Promise.resolve(state.compareGroundTexture);
  }
  if (state.compareGroundLoading === key) return Promise.resolve(null);
  state.compareGroundLoading = key;

  const midLat = (b.minLat + b.maxLat) / 2;
  const widthM = (b.maxLon - b.minLon) * 111320 * Math.cos(midLat * Math.PI / 180);
  let z = Math.round(Math.log2(COMPARE_TILE_TARGET_PX * EARTH_EQUATOR_M / (COMPARE_TILE_SIZE * Math.max(widthM, 1))));
  z = Math.max(1, Math.min(19, z));

  const [tx1Raw, ty1Raw] = compareLatLonToTile(b.maxLat, b.minLon, z);
  const [tx2Raw, ty2Raw] = compareLatLonToTile(b.minLat, b.maxLon, z);
  const minTx = Math.floor(tx1Raw);
  const maxTx = Math.floor(tx2Raw);
  const minTy = Math.floor(ty1Raw);
  const maxTy = Math.floor(ty2Raw);

  const cols = maxTx - minTx + 1;
  const rows = maxTy - minTy + 1;
  const cnv = document.createElement('canvas');
  cnv.width = cols * COMPARE_TILE_SIZE;
  cnv.height = rows * COMPARE_TILE_SIZE;
  const ctx = cnv.getContext('2d');

  const fetches = [];
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + ty + '/' + tx;
      fetches.push(new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const dx = (tx - minTx) * COMPARE_TILE_SIZE;
        const dy = (ty - minTy) * COMPARE_TILE_SIZE;
        img.onload = () => { ctx.drawImage(img, dx, dy); resolve(); };
        img.onerror = () => resolve(); // missing tile leaves a blank patch
        img.src = url;
      }));
    }
  }

  return Promise.all(fetches).then(() => {
    // Soft-edge fade-to-black. Two passes in texture space so the effect
    // gets warped onto the 3D ground quad along with the tiles:
    //   1. multiply with a radial black gradient — pixels in the outer ring
    //      darken progressively toward black,
    //   2. destination-in with a radial alpha gradient — outer ring also
    //      fades to fully transparent, so the texture vanishes into the
    //      already-dark canvas background.
    const cx = cnv.width / 2;
    const cy = cnv.height / 2;
    const maxR = Math.hypot(cx, cy);

    const darken = ctx.createRadialGradient(cx, cy, maxR * 0.08, cx, cy, maxR * 0.6);
    darken.addColorStop(0, 'rgba(255, 255, 255, 1)'); // no darken in centre
    darken.addColorStop(1, 'rgba(0, 0, 0, 1)');       // full black at ~60% radius
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = darken;
    ctx.fillRect(0, 0, cnv.width, cnv.height);

    const fade = ctx.createRadialGradient(cx, cy, maxR * 0.1, cx, cy, maxR * 0.55);
    fade.addColorStop(0, 'rgba(255, 255, 255, 1)');
    fade.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, cnv.width, cnv.height);
    ctx.globalCompositeOperation = 'source-over';

    const [latNW, lonNW] = compareTileToLatLon(minTx, minTy, z);
    const [latSE, lonSE] = compareTileToLatLon(maxTx + 1, maxTy + 1, z);
    const tex = {
      key,
      canvas: cnv,
      bounds: { minLat: latSE, maxLat: latNW, minLon: lonNW, maxLon: lonSE },
    };
    state.compareGroundTexture = tex;
    state.compareGroundLoading = null;
    return tex;
  });
}

// ── 3D track view (canvas, no external libs) ──
function renderCompare3d() {
  const canvas = document.getElementById('compare3dCanvas');
  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  // High-DPI handling — render at devicePixelRatio so the lines stay crisp
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = rect.width, H = rect.height;
  ctx.fillStyle = (typeof getThemeColor === 'function' && getThemeColor('bg-inset')) || '#0f172a';
  ctx.fillRect(0, 0, W, H);

  const entries = getSelectedCompareEntries();
  if (!entries.length) return;

  // Build a list of (x, y, z) points per jump in metres relative to a shared
  // origin centred on all selected exits. Y is altitude (positive up). The
  // X/Z plane is local equirectangular metres, cosine-corrected by latitude.
  const exitLats = [], exitLons = [], exitAlts = [];
  entries.forEach(({ data }) => {
    if (data.exitPos) {
      exitLats.push(data.exitPos[0]);
      exitLons.push(data.exitPos[1]);
    }
    if (data.alts && data.alts.length) {
      // exit altitude = first sample at or after T=0
      let idx = data.times.findIndex(t => t >= 0);
      if (idx < 0) idx = 0;
      exitAlts.push(data.alts[idx]);
    }
  });
  if (!exitLats.length) return;
  const lat0 = exitLats.reduce((a, b) => a + b, 0) / exitLats.length;
  const lon0 = exitLons.reduce((a, b) => a + b, 0) / exitLons.length;
  const alt0 = exitAlts.reduce((a, b) => a + b, 0) / exitAlts.length;
  const latToM = 110540;
  const lonToM = 111320 * Math.cos(lat0 * Math.PI / 180);

  // Bounds for auto-fit are computed from the FULL data of every selected
  // jump, independent of the scrub position. This locks the camera framing
  // so it doesn't lurch as points pop in/out while the user scrubs the
  // slider. Each track is also pre-projected to (x, y, z) so we can reuse
  // the projection in the truncation loop below.
  const fullTracks = entries.map(({ name, data }) => {
    const pts = [];
    for (let i = 0; i < data.path.length; i++) {
      const [lat, lon] = data.path[i];
      const x = (lon - lon0) * lonToM;
      const z = (lat - lat0) * latToM;
      const y = (data.alts[i] - alt0);
      pts.push([x, y, z]);
    }
    return { name, data, pts };
  });

  let maxXZ = 1, minY = 0, maxY = 0;
  fullTracks.forEach(t => t.pts.forEach(([x, y, z]) => {
    if (Math.abs(x) > maxXZ) maxXZ = Math.abs(x);
    if (Math.abs(z) > maxXZ) maxXZ = Math.abs(z);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }));
  const yRange = Math.max(1, maxY - minY);

  // Per-jump truncation: each jump's own elapsed time is derived from the
  // global scrub position (in absolute ms) minus its own exit timestamp.
  // We also keep the fractional position between samples (`headFrac`) so the
  // head-of-track dot and its speed label can interpolate smoothly between
  // 10 Hz CSV samples — otherwise the dot snaps to discrete positions and
  // looks "laggy" in recorded clips, especially at high time-compression.
  // cutoff = 0 means the jump hasn't started at this clock time yet.
  const scrubMs = state.compare3dScrubMs;
  const useScrub = state.compare3dScrubMax > state.compare3dScrubMin;
  const tracks = fullTracks.map(({ name, data, pts: fullPts }) => {
    let cutoff = fullPts.length;
    let headFrac = 0; // 0..1 fraction past the cutoff-1 sample toward cutoff
    // Per-jump elapsed seconds since its own exit. Used to gate the head
    // dot/tooltip so it only appears after the exit moment is reached
    // (otherwise the dot would float over the airplane approach segment).
    let elapsedSec = Infinity;
    if (useScrub && typeof data.exitTimestampMs === 'number') {
      elapsedSec = (scrubMs - data.exitTimestampMs) / 1000;
      cutoff = 0;
      for (let i = 0; i < data.times.length; i++) {
        if (data.times[i] <= elapsedSec) cutoff = i + 1;
        else break;
      }
      if (cutoff > 0 && cutoff < data.times.length) {
        const t0 = data.times[cutoff - 1];
        const t1 = data.times[cutoff];
        if (t1 > t0) {
          headFrac = Math.max(0, Math.min(1, (elapsedSec - t0) / (t1 - t0)));
        }
      }
    }
    return {
      name,
      color: compareJumpColor(name),
      fullPts,
      cutoff,
      headFrac,
      elapsedSec,
      // Convenience: truncated points used by the existing draw loop for the
      // line itself. Sub-sample interpolation only affects the head marker.
      pts: cutoff === fullPts.length ? fullPts : fullPts.slice(0, cutoff),
      headIdx: cutoff - 1,
    };
  });

  // Camera
  const yaw = state.compare3dCamera.yaw * Math.PI / 180;
  const pitch = state.compare3dCamera.pitch * Math.PI / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);

  // Pick a scale that fits both horizontal extent and altitude range. Use
  // separate scales for X/Z vs Y so tall narrow tracks aren't squashed.
  const scaleXZ = (Math.min(W, H) / 2 / maxXZ) * 0.85 * state.compare3dCamera.zoom;
  const scaleY = (H / 2 / yRange) * 0.85 * state.compare3dCamera.zoom;

  const panX = state.compare3dCamera.panX || 0;
  const panY = state.compare3dCamera.panY || 0;
  function project(x, y, z) {
    // Yaw around Y, then pitch around X
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const yScaled = y * scaleY;
    const xScaled = x1 * scaleXZ;
    const zScaled = z1 * scaleXZ;
    const y2 = yScaled * cp - zScaled * sp;
    return [W / 2 + xScaled + panX, H / 2 - y2 + panY];
  }

  // ── Ground plane: satellite imagery, warped to the projected quad ──
  // Bbox in lat/lon of all selected tracks (with a touch of padding).
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  entries.forEach(({ data }) => {
    data.path.forEach(([lat, lon]) => {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    });
  });
  if (isFinite(minLat) && isFinite(minLon)) {
    // Pad each side so the satellite ground plane covers ~4× the linear
    // extent of the track footprint. With the soft radial fade applied to
    // the cached texture, only the centre is fully opaque; the outer ring
    // gradually darkens and fades to transparent so the edges blend into
    // the dark background.
    const padLat = Math.max(0.002, (maxLat - minLat) * 2.5);
    const padLon = Math.max(0.002, (maxLon - minLon) * 2.5);
    const bbox = {
      minLat: minLat - padLat,
      maxLat: maxLat + padLat,
      minLon: minLon - padLon,
      maxLon: maxLon + padLon,
    };
    const key = compareGroundKey(bbox);
    const tex = state.compareGroundTexture && state.compareGroundTexture.key === key
      ? state.compareGroundTexture
      : null;

    if (tex) {
      // The texture covers slightly more than the requested bbox (full tiles).
      // Project the texture's own corners into screen space and warp via
      // setTransform — valid because our projection is orthographic, so a
      // flat plane in world space maps to a parallelogram on screen.
      const tb = tex.bounds;
      const corner = (lat, lon) => {
        const x = (lon - lon0) * lonToM;
        const z = (lat - lat0) * latToM;
        return project(x, minY, z);
      };
      const nw = corner(tb.maxLat, tb.minLon);
      const ne = corner(tb.maxLat, tb.maxLon);
      const sw = corner(tb.minLat, tb.minLon);
      const tW = tex.canvas.width;
      const tH = tex.canvas.height;
      const a = (ne[0] - nw[0]) / tW;
      const b = (ne[1] - nw[1]) / tW;
      const cM = (sw[0] - nw[0]) / tH;
      const dM = (sw[1] - nw[1]) / tH;
      ctx.save();
      ctx.globalAlpha = 0.85;
      // Pre-multiply with the existing dpr transform so the warp lands at
      // the same device pixels as the rest of the scene.
      ctx.setTransform(dpr * a, dpr * b, dpr * cM, dpr * dM, dpr * nw[0], dpr * nw[1]);
      ctx.drawImage(tex.canvas, 0, 0);
      ctx.restore();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } else {
      // Texture not ready — show a slate frame and kick off a fetch. Trigger
      // a re-render once the tiles have stitched.
      ctx.strokeStyle = (typeof getThemeColor === 'function' && getThemeColor('border')) || '#334155';
      ctx.lineWidth = 1;
      const slateCorners = [
        [-maxXZ, minY, -maxXZ],
        [ maxXZ, minY, -maxXZ],
        [ maxXZ, minY,  maxXZ],
        [-maxXZ, minY,  maxXZ],
      ].map(p => project(...p));
      ctx.beginPath();
      slateCorners.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
      ctx.closePath();
      ctx.stroke();
      loadCompareGroundTexture(bbox).then(t => {
        if (t && state.compareActiveView === 'view3d') renderCompare3d();
      });
    }
  }
  // Vertical post at the origin so the user can see where the exit pivot is
  ctx.strokeStyle = (typeof getThemeColor === 'function' && getThemeColor('border-strong')) || '#475569';
  ctx.beginPath();
  const ground0 = project(0, minY, 0);
  const top0 = project(0, maxY, 0);
  ctx.moveTo(ground0[0], ground0[1]);
  ctx.lineTo(top0[0], top0[1]);
  ctx.stroke();

  // Tracks — also cache projected screen positions for hover hit-testing.
  state.compare3dProjected = tracks.map(t => {
    const screen = t.pts.map(p => project(p[0], p[1], p[2]));
    // Sub-sample interpolated head position. When the scrubber falls between
    // two data samples, project the next one too and lerp — that makes the
    // head dot move smoothly during clip recording instead of stepping at
    // the underlying 10 Hz sample rate.
    let interpHead = null;
    let interpSpeed = null;
    if (t.cutoff > 0 && t.cutoff < t.fullPts.length && t.headFrac > 0) {
      const nextWorld = t.fullPts[t.cutoff];
      const next = project(nextWorld[0], nextWorld[1], nextWorld[2]);
      const prev = screen[t.cutoff - 1];
      const f = t.headFrac;
      interpHead = [
        prev[0] * (1 - f) + next[0] * f,
        prev[1] * (1 - f) + next[1] * f,
      ];
      const data0 = state.compareDataCache.get(t.name);
      if (data0) {
        const v0 = data0.vertSpeeds[t.cutoff - 1];
        const v1 = data0.vertSpeeds[t.cutoff];
        if (v0 != null && v1 != null && isFinite(v0) && isFinite(v1)) {
          interpSpeed = v0 * (1 - f) + v1 * f;
        }
      }
    }

    ctx.strokeStyle = t.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    screen.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
    // Extend the line to the interpolated head so the polyline visually
    // ends exactly where the dot is, not at the previous sample.
    if (interpHead && screen.length > 0) ctx.lineTo(interpHead[0], interpHead[1]);
    ctx.stroke();
    // Exit dot at the actual exit point — only when it's actually been
    // reached (otherwise the scrubber is still showing pre-exit data).
    const data = state.compareDataCache.get(t.name);
    if (data) {
      let exitIdx = data.times.findIndex(tt => tt >= 0);
      if (exitIdx >= 0 && exitIdx < screen.length) {
        const [ex, ey] = screen[exitIdx];
        ctx.fillStyle = t.color;
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ex, ey, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    // Leading-edge "head" marker: when the slider is below 100%, draw a dot
    // at the latest visible point of each track and label it with the
    // vertical speed at that moment. At 100% (= scrubMs >= scrubMax) every
    // track is fully shown so showing dots is just visual noise.
    const showHead = useScrub
      && state.compare3dScrubMs < state.compare3dScrubMax
      && t.headIdx >= 0 && t.headIdx < screen.length
      && data
      // Suppress the dot + tooltip during the pre-exit segment so the head
      // marker only appears once the jump has actually started.
      && t.elapsedSec >= 0;
    if (showHead) {
      const [hx, hy] = interpHead || screen[t.headIdx];
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const v = interpSpeed != null ? interpSpeed : data.vertSpeeds[t.headIdx];
      if (v != null && isFinite(v)) {
        const nameText = t.name;
        const speedText = v.toFixed(1) + ' km/h';
        const nameFont = '500 10px "Segoe UI", system-ui, sans-serif';
        const speedFont = '600 11px "Segoe UI", system-ui, sans-serif';
        ctx.font = nameFont;
        const nameW = ctx.measureText(nameText).width;
        ctx.font = speedFont;
        const speedW = ctx.measureText(speedText).width;
        const padX = 6, padY = 4;
        const lineH = 13;
        const boxW = Math.max(nameW, speedW) + padX * 2;
        const boxH = lineH * 2 + padY * 2;
        const boxX = hx + 8;
        const boxY = hy - boxH - 2;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.strokeStyle = t.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(boxX, boxY, boxW, boxH);
        ctx.fill();
        ctx.stroke();
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#94a3b8';
        ctx.font = nameFont;
        ctx.fillText(nameText, boxX + padX, boxY + padY);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = speedFont;
        ctx.fillText(speedText, boxX + padX, boxY + padY + lineH);
      }
    }
    return { name: t.name, color: t.color, screen };
  });

  // Hover marker — drawn last so it's on top of everything.
  const hover = state.compare3dHover;
  if (hover) {
    const tp = state.compare3dProjected.find(p => p.name === hover.name);
    if (tp && tp.screen[hover.idx]) {
      const [hx, hy] = tp.screen[hover.idx];
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = tp.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}

// ── 3D hover tooltip ──
function clearCompare3dHover() {
  if (!state.compare3dHover) return;
  state.compare3dHover = null;
  const tooltip = document.getElementById('compare3dTooltip');
  if (tooltip) tooltip.hidden = true;
  if (state.compareActiveView === 'view3d') renderCompare3d();
}

function showCompare3dHover(name, idx, mx, my) {
  const data = state.compareDataCache.get(name);
  if (!data) return clearCompare3dHover();
  state.compare3dHover = { name, idx };
  const tooltip = document.getElementById('compare3dTooltip');
  if (!tooltip) return;
  const t = data.times[idx];
  const sign = t >= 0 ? '+' : '−';
  const tStr = 'T' + sign + Math.abs(t).toFixed(1) + ' s';
  const alt = data.alts[idx];
  const altFt = alt * 3.28084;
  const vert = data.vertSpeeds[idx];
  const vertMph = vert != null ? vert * 0.621371 : null;

  tooltip.innerHTML = '';
  const nameRow = document.createElement('div');
  nameRow.className = 'compare-3d-tooltip-name';
  const swatch = document.createElement('span');
  swatch.className = 'compare-color-swatch';
  swatch.style.background = compareJumpColor(name);
  nameRow.appendChild(swatch);
  nameRow.appendChild(document.createTextNode(name));
  tooltip.appendChild(nameRow);

  const addRow = (label, value) => {
    const row = document.createElement('div');
    row.className = 'compare-3d-tooltip-row';
    const l = document.createElement('span'); l.textContent = label;
    const v = document.createElement('span'); v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    tooltip.appendChild(row);
  };
  addRow('Time', tStr);
  if (isFinite(alt)) addRow('Altitude', alt.toFixed(0) + ' m / ' + altFt.toFixed(0) + ' ft');
  if (vert != null && isFinite(vert)) addRow('Vert. speed', vert.toFixed(1) + ' km/h');

  // Position: nudge so the tooltip stays inside the canvas bounds.
  const canvas = document.getElementById('compare3dCanvas');
  const rect = canvas.getBoundingClientRect();
  tooltip.hidden = false;
  const tipRect = tooltip.getBoundingClientRect();
  let left = mx + 14;
  let top = my + 14;
  if (left + tipRect.width > rect.width) left = mx - tipRect.width - 14;
  if (top + tipRect.height > rect.height) top = my - tipRect.height - 14;
  tooltip.style.left = Math.max(4, left) + 'px';
  tooltip.style.top = Math.max(4, top) + 'px';

  if (state.compareActiveView === 'view3d') renderCompare3d();
}

// 3D mouse interaction — left-drag rotates, right/middle/shift+left-drag pans,
// wheel zooms, hover (no buttons) → tooltip. Suppresses the native context
// menu so right-drag is usable.
(function() {
  const canvas = document.getElementById('compare3dCanvas');
  if (!canvas) return;
  let dragging = false, mode = 'rotate', lastX = 0, lastY = 0;

  function hitTest(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let bestDist = 14; // px hit radius
    let best = null;
    (state.compare3dProjected || []).forEach(track => {
      track.screen.forEach((p, i) => {
        const dx = p[0] - mx;
        const dy = p[1] - my;
        const d = Math.hypot(dx, dy);
        if (d < bestDist) { bestDist = d; best = { name: track.name, idx: i, mx, my }; }
      });
    });
    return best;
  }

  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('mousedown', e => {
    dragging = true;
    const isPan = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
    mode = isPan ? 'pan' : 'rotate';
    lastX = e.clientX;
    lastY = e.clientY;
    if (state.compare3dHover) clearCompare3dHover();
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (dragging) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (mode === 'pan') {
        state.compare3dCamera.panX += dx;
        state.compare3dCamera.panY += dy;
      } else {
        state.compare3dCamera.yaw = (state.compare3dCamera.yaw + dx * 0.5) % 360;
        // Clamp pitch to [0°, 89°] so the camera can never tilt below the
        // ground plane — anything < 0° would view the satellite imagery
        // from underneath, which doesn't make sense for the scene.
        state.compare3dCamera.pitch = Math.max(0, Math.min(89, state.compare3dCamera.pitch + dy * 0.5));
      }
      if (state.compareActiveView === 'view3d') renderCompare3d();
    }
  });
  canvas.addEventListener('mousemove', e => {
    if (dragging || state.compareActiveView !== 'view3d') return;
    const hit = hitTest(e);
    if (hit) {
      const same = state.compare3dHover && state.compare3dHover.name === hit.name && state.compare3dHover.idx === hit.idx;
      if (same) {
        // same data point — only reposition the tooltip (cheaper than a render)
        const tooltip = document.getElementById('compare3dTooltip');
        if (tooltip && !tooltip.hidden) {
          const rect = canvas.getBoundingClientRect();
          const tipRect = tooltip.getBoundingClientRect();
          let left = hit.mx + 14;
          let top = hit.my + 14;
          if (left + tipRect.width > rect.width) left = hit.mx - tipRect.width - 14;
          if (top + tipRect.height > rect.height) top = hit.my - tipRect.height - 14;
          tooltip.style.left = Math.max(4, left) + 'px';
          tooltip.style.top = Math.max(4, top) + 'px';
        }
      } else {
        showCompare3dHover(hit.name, hit.idx, hit.mx, hit.my);
      }
    } else if (state.compare3dHover) {
      clearCompare3dHover();
    }
  });
  canvas.addEventListener('mouseleave', clearCompare3dHover);
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    state.compare3dCamera.zoom = Math.max(0.2, Math.min(5, state.compare3dCamera.zoom * factor));
    if (state.compareActiveView === 'view3d') renderCompare3d();
  }, { passive: false });
})();

// ── 3D auto-rotate + scrubber ──
function formatScrubClock(ms) {
  if (!isFinite(ms) || ms <= 0) return '--:--:--';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// Recompute the scrub range from currently selected jumps and clamp the
// current scrub position into the new range. Called whenever the selection
// changes or the 3D view first becomes active.
function refreshCompare3dScrub() {
  let min = Infinity, max = -Infinity;
  let hadAny = false;
  state.compareSelected.forEach(name => {
    const data = state.compareDataCache.get(name);
    if (!data) return;
    const exitMs = data.exitTimestampMs;
    if (typeof exitMs !== 'number' || !isFinite(exitMs)) return;
    const canopyMs = exitMs + (data.canopyTimeRel || 0) * 1000;
    if (exitMs < min) min = exitMs;
    if (canopyMs > max) max = canopyMs;
    hadAny = true;
  });
  if (!hadAny) {
    state.compare3dScrubMin = 0;
    state.compare3dScrubMax = 0;
    state.compare3dScrubMs = 0;
  } else {
    // Start the slider (and clip recordings) a few seconds BEFORE the earliest
    // exit so the airplane-approach segment is included as a lead-in. The
    // -5 s pre-exit slice is already cached in each jump's data window.
    const LEAD_IN_MS = 5 * 1000;
    state.compare3dScrubMin = min - LEAD_IN_MS;
    state.compare3dScrubMax = max;
    // Default to 100% on first load. On selection change, clamp into new range
    // (preserves the user's chosen position when possible).
    if (!isFinite(state.compare3dScrubMs)
        || state.compare3dScrubMs < state.compare3dScrubMin
        || state.compare3dScrubMs > state.compare3dScrubMax) {
      state.compare3dScrubMs = state.compare3dScrubMax;
    }
  }
  syncCompare3dScrubUI();
  syncCompareClipButton();
}

function syncCompare3dScrubUI() {
  const slider = document.getElementById('compare3dScrubSlider');
  const label = document.getElementById('compare3dScrubTime');
  const startLabel = document.getElementById('compare3dScrubStart');
  if (!slider || !label) return;
  const min = state.compare3dScrubMin;
  const max = state.compare3dScrubMax;
  const ms = state.compare3dScrubMs;
  if (max > min) {
    const pct = Math.max(0, Math.min(10000, Math.round(((ms - min) / (max - min)) * 10000)));
    slider.value = String(pct);
    // Stay disabled while recording; otherwise enabled when there's data.
    slider.disabled = !!state.compareClipRecording;
    label.textContent = formatScrubClock(ms);
    if (startLabel) startLabel.textContent = formatScrubClock(min);
  } else {
    slider.value = '10000';
    slider.disabled = true;
    label.textContent = '--:--:--';
    if (startLabel) startLabel.textContent = '--:--:--';
  }
}

function compare3dAnimationFrame(ts) {
  if (!state.compare3dAnimating) return;
  if (state.compareActiveView !== 'view3d') {
    stopCompare3dAnimation();
    return;
  }
  const last = state.compare3dLastFrameTs || ts;
  const dt = Math.max(0, Math.min(0.1, (ts - last) / 1000));
  state.compare3dLastFrameTs = ts;
  state.compare3dCamera.yaw =
    (state.compare3dCamera.yaw + COMPARE_3D_AUTO_ROTATE_DEG_PER_SEC * dt + 360) % 360;
  renderCompare3d();
  state.compare3dRafId = requestAnimationFrame(compare3dAnimationFrame);
}

function startCompare3dAnimation() {
  if (state.compare3dAnimating) return;
  state.compare3dAnimating = true;
  state.compare3dLastFrameTs = 0;
  state.compare3dRafId = requestAnimationFrame(compare3dAnimationFrame);
  syncCompare3dPlayButton();
}

function stopCompare3dAnimation() {
  if (state.compare3dRafId != null) {
    cancelAnimationFrame(state.compare3dRafId);
    state.compare3dRafId = null;
  }
  state.compare3dAnimating = false;
  state.compare3dLastFrameTs = 0;
  syncCompare3dPlayButton();
}

function syncCompare3dPlayButton() {
  const btn = document.getElementById('compare3dPlay');
  if (!btn) return;
  const playing = !!state.compare3dAnimating;
  btn.classList.toggle('playing', playing);
  btn.setAttribute('aria-label', playing ? 'Stop auto-rotate' : 'Auto-rotate 3D view');
  btn.querySelectorAll('.compare-3d-play-icon').forEach(icon => {
    const isPause = icon.dataset.icon === 'pause';
    // Pause icon visible while rotating; rotate icon visible while idle.
    icon.hidden = isPause ? !playing : playing;
  });
}

// Tab buttons
document.querySelectorAll('.compare-view-tab').forEach(btn => {
  btn.addEventListener('click', () => setCompareView(btn.dataset.view));
});

// Play / pause button for the 3D auto-rotate. Clicking explicitly toggles
// rotation AND records the user's intent — so a manual pause survives
// view switches but is reset when the modal is reopened.
(function() {
  const btn = document.getElementById('compare3dPlay');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (state.compare3dAnimating) {
      stopCompare3dAnimation();
      state.compare3dRotateUserPaused = true;
    } else {
      startCompare3dAnimation();
      state.compare3dRotateUserPaused = false;
    }
  });
})();

// Time scrubber slider — represents an absolute clock instant. Each jump
// computes its own elapsed time relative to its own exit timestamp.
(function() {
  const slider = document.getElementById('compare3dScrubSlider');
  if (!slider) return;
  slider.addEventListener('input', () => {
    if (state.compareClipRecording) return; // ignore manual drag during recording
    const min = state.compare3dScrubMin;
    const max = state.compare3dScrubMax;
    if (max <= min) return;
    const pct = Number(slider.value) / 10000;
    state.compare3dScrubMs = min + pct * (max - min);
    const label = document.getElementById('compare3dScrubTime');
    if (label) label.textContent = formatScrubClock(state.compare3dScrubMs);
    if (state.compareActiveView === 'view3d') renderCompare3d();
  });
})();

// ── "Create clip" button: record a 30-second video of the slider sweeping
// from 0% to 100%, captured from the 3D canvas via MediaRecorder. ──
function syncCompareClipButton() {
  const btn = document.getElementById('compare3dClip');
  if (!btn) return;
  const recording = !!state.compareClipRecording;
  btn.classList.toggle('recording', recording);
  btn.textContent = recording ? 'Recording' : 'Create clip';
  // Only enable when there's actual data to scrub through.
  const canRecord = !recording && state.compare3dScrubMax > state.compare3dScrubMin;
  btn.disabled = !canRecord;
}

function pickCompareClipMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of candidates) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return null;
}

async function createCompareClip(durationSec) {
  if (state.compareClipRecording) return;
  const min = state.compare3dScrubMin;
  const max = state.compare3dScrubMax;
  if (max <= min) return;
  if (!isFinite(durationSec) || durationSec <= 0) return;

  const canvas = document.getElementById('compare3dCanvas');
  if (!canvas) return;
  const mimeType = pickCompareClipMimeType();
  if (!mimeType) {
    alert('Sorry — your browser does not expose MediaRecorder for canvas video capture.');
    return;
  }

  let stream;
  try { stream = canvas.captureStream(30); } catch (e) {
    alert('Could not capture the 3D canvas: ' + e.message);
    return;
  }
  // Very high bitrate so the encoder isn't the bottleneck. Canvas resolution
  // is whatever device-pixel-ratio gives at the modal's CSS size — the
  // bitrate alone is the lever for visible compression artifacts now.
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 50_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

  state.compareClipRecording = true;
  state.compareClipRecorder = recorder;
  syncCompareClipButton();
  document.getElementById('compare3dScrubSlider').disabled = true;
  document.getElementById('compare3dPlay').disabled = true;

  // Reset to 0% and render one frame before the recorder starts so the
  // first frame of the clip is the start, not whatever was on screen.
  state.compare3dScrubMs = min;
  syncCompare3dScrubUI();
  renderCompare3d();

  recorder.start();

  return new Promise(resolve => {
    const startedAt = performance.now();
    const scrubMs = durationSec * 1000;
    const tailMs = COMPARE_CLIP_TAIL_SEC * 1000;
    const totalMs = scrubMs + tailMs;
    function tick() {
      if (!state.compareClipRecording) return; // aborted
      const elapsed = performance.now() - startedAt;
      // Linear scrub from 0% → 100% over `scrubMs`, then hold at 100% for
      // `tailMs` so the final frame stays on screen for a few seconds.
      const t = Math.min(elapsed / scrubMs, 1);
      state.compare3dScrubMs = min + t * (max - min);
      syncCompare3dScrubUI();
      renderCompare3d();
      if (elapsed < totalMs) {
        state.compareClipRafId = requestAnimationFrame(tick);
      } else {
        // Stop & save
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: mimeType });
          const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'flysight-compare-' + stamp + '.' + ext;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);

          state.compareClipRecording = false;
          state.compareClipRecorder = null;
          state.compareClipRafId = null;
          syncCompareClipButton();
          document.getElementById('compare3dScrubSlider').disabled = false;
          document.getElementById('compare3dPlay').disabled = false;
          resolve();
        };
        try { recorder.stop(); } catch (e) {}
      }
    }
    state.compareClipRafId = requestAnimationFrame(tick);
  });
}

function abortCompareClip() {
  if (!state.compareClipRecording) return;
  if (state.compareClipRafId != null) {
    cancelAnimationFrame(state.compareClipRafId);
    state.compareClipRafId = null;
  }
  const r = state.compareClipRecorder;
  if (r && r.state !== 'inactive') {
    try { r.ondataavailable = null; r.onstop = null; r.stop(); } catch (e) {}
  }
  state.compareClipRecorder = null;
  state.compareClipRecording = false;
  syncCompareClipButton();
  const slider = document.getElementById('compare3dScrubSlider');
  const playBtn = document.getElementById('compare3dPlay');
  if (slider) slider.disabled = false;
  if (playBtn) playBtn.disabled = false;
}

function formatRealtimeDurationLabel(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem === 0 ? m + ' min' : m + 'm ' + rem + 's';
  const h = Math.floor(m / 60);
  const mRem = m % 60;
  return mRem === 0 ? h + ' h' : h + 'h ' + mRem + 'm';
}

function showCompareClipMenu(open) {
  const menu = document.getElementById('compare3dClipMenu');
  if (!menu) return;
  if (open) {
    const realtimeBtn = document.getElementById('compare3dClipMenuRealtime');
    if (realtimeBtn) {
      const seconds = (state.compare3dScrubMax - state.compare3dScrubMin) / 1000;
      const label = formatRealtimeDurationLabel(seconds);
      realtimeBtn.textContent = label
        ? 'Full real-time (' + label + ')'
        : 'Full real-time';
    }
  }
  menu.hidden = !open;
}

(function() {
  const btn = document.getElementById('compare3dClip');
  const menu = document.getElementById('compare3dClipMenu');
  if (!btn || !menu) return;

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (state.compareClipRecording) return;
    showCompareClipMenu(menu.hidden);
  });

  menu.addEventListener('click', e => {
    const target = e.target.closest('button[data-mode]');
    if (!target) return;
    e.stopPropagation();
    showCompareClipMenu(false);
    const mode = target.dataset.mode;
    let durationSec;
    if (mode === '30') {
      durationSec = 30;
    } else if (mode === 'realtime') {
      durationSec = (state.compare3dScrubMax - state.compare3dScrubMin) / 1000;
    }
    createCompareClip(durationSec);
  });

  // Click anywhere else to dismiss the menu.
  document.addEventListener('click', () => showCompareClipMenu(false));
  // Escape also dismisses.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !menu.hidden) showCompareClipMenu(false);
  });
})();

// Backdrop clicks are ignored — only the X button (or Escape) closes the modal
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('compareModal').classList.contains('open')) {
    closeCompareModal();
  }
});
