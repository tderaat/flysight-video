
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

  return { path, exitPos, canopyPos, headingLine, times, alts, vertSpeeds, diveAngles };
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
  await renderCompareJumpsList();
  renderCompareView();
}

function closeCompareModal() {
  document.getElementById('compareModal').classList.remove('open');
  if (state.compareMapInstance) {
    state.compareMapInstance.remove();
    state.compareMapInstance = null;
  }
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
  ctx.fillStyle = '#0f172a';
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

  const tracks = entries.map(({ name, data }) => {
    const pts = [];
    for (let i = 0; i < data.path.length; i++) {
      const [lat, lon] = data.path[i];
      const x = (lon - lon0) * lonToM;
      const z = (lat - lat0) * latToM;
      const y = (data.alts[i] - alt0); // metres above mean exit
      pts.push([x, y, z]);
    }
    return { name, color: compareJumpColor(name), pts };
  });

  // Compute bounding range so we auto-fit to the data
  let maxXZ = 1, minY = 0, maxY = 0;
  tracks.forEach(t => t.pts.forEach(([x, y, z]) => {
    maxXZ = Math.max(maxXZ, Math.abs(x), Math.abs(z));
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }));
  const yRange = Math.max(1, maxY - minY);

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

  // Ground plane: draw a square frame at y = minY
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  const groundCorners = [
    [-maxXZ, minY, -maxXZ],
    [ maxXZ, minY, -maxXZ],
    [ maxXZ, minY,  maxXZ],
    [-maxXZ, minY,  maxXZ],
  ].map(p => project(...p));
  ctx.beginPath();
  groundCorners.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
  ctx.closePath();
  ctx.stroke();
  // Vertical post at the origin
  ctx.strokeStyle = '#475569';
  ctx.beginPath();
  const ground0 = project(0, minY, 0);
  const top0 = project(0, maxY, 0);
  ctx.moveTo(ground0[0], ground0[1]);
  ctx.lineTo(top0[0], top0[1]);
  ctx.stroke();

  // Tracks
  tracks.forEach(t => {
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    t.pts.forEach((p, i) => {
      const [sx, sy] = project(p[0], p[1], p[2]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    // Exit dot at the first point of the jump's window (T=-5s start)
    // Find the actual exit point for clarity
    const data = state.compareDataCache.get(t.name);
    if (data) {
      let exitIdx = data.times.findIndex(tt => tt >= 0);
      if (exitIdx >= 0 && exitIdx < t.pts.length) {
        const [ex, ey] = project(...t.pts[exitIdx]);
        ctx.fillStyle = t.color;
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ex, ey, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  });
}

// 3D mouse interaction — left-drag rotates, right/middle/shift+left-drag pans,
// wheel zooms. Suppresses the native context menu so right-drag is usable.
(function() {
  const canvas = document.getElementById('compare3dCanvas');
  if (!canvas) return;
  let dragging = false, mode = 'rotate', lastX = 0, lastY = 0;
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('mousedown', e => {
    dragging = true;
    const isPan = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
    mode = isPan ? 'pan' : 'rotate';
    lastX = e.clientX;
    lastY = e.clientY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (mode === 'pan') {
      state.compare3dCamera.panX += dx;
      state.compare3dCamera.panY += dy;
    } else {
      state.compare3dCamera.yaw = (state.compare3dCamera.yaw + dx * 0.5) % 360;
      state.compare3dCamera.pitch = Math.max(-89, Math.min(89, state.compare3dCamera.pitch + dy * 0.5));
    }
    if (state.compareActiveView === 'view3d') renderCompare3d();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    state.compare3dCamera.zoom = Math.max(0.2, Math.min(5, state.compare3dCamera.zoom * factor));
    if (state.compareActiveView === 'view3d') renderCompare3d();
  }, { passive: false });
})();

// Tab buttons
document.querySelectorAll('.compare-view-tab').forEach(btn => {
  btn.addEventListener('click', () => setCompareView(btn.dataset.view));
});

document.getElementById('compareModal').addEventListener('click', function(e) {
  if (e.target === this) closeCompareModal();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('compareModal').classList.contains('open')) {
    closeCompareModal();
  }
});
