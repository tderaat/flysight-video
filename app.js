// ── Video overlay state ──
let videoObjectURL = null;
let videoExitTime = null;
let currentFlightData = null;

// ── Widget system ──
let widgets = [];
let selectedWidgetId = null;
let nextWidgetId = 1;
let widgetDragState = null; // { mode: 'move'|'resize', widgetId, startX, startY, origX, origY, origW, origH, handle }

const WIDGET_TYPES = {
  info: {
    label: 'Info',
    defaultConfig: { showTime: true, showAltitude: true, showSpeed: true, showHSpeed: true, showScore: true, units: 'both', fadeIn: true },
    render: renderInfoWidget,
    renderPreview: renderInfoPreviewCard,
    configUI: buildInfoConfigPanel,
  },
  vertSpeed: {
    label: 'Vert. Speed',
    defaultConfig: { dataSource: 'vertSpeed', units: 'metric', fadeIn: true, showBackground: false, showLabel: false },
    render: renderSpeedWidget,
    renderPreview: renderVertSpeedPreviewCard,
    configUI: buildSpeedConfigPanel,
  },
  horzSpeed: {
    label: 'Horiz. Speed',
    defaultConfig: { dataSource: 'horzSpeed', units: 'metric', fadeIn: true, showBackground: false, showLabel: false },
    render: renderSpeedWidget,
    renderPreview: renderHorzSpeedPreviewCard,
    configUI: buildSpeedConfigPanel,
  },
  altGraph: {
    label: 'Alt. Graph',
    defaultConfig: { showMeasuringZone: true, showScoringZone: true, showLabel: false, showBackground: false, fadeIn: true },
    render: renderAltGraphWidget,
    renderPreview: renderAltGraphPreviewCard,
    configUI: buildAltGraphConfigPanel,
  },
  altimeter: {
    label: 'Altimeter',
    defaultConfig: { units: 'metric', showBackground: false, showLabel: false, fadeIn: true },
    render: renderAltimeterWidget,
    renderPreview: renderAltimeterPreviewCard,
    configUI: buildAltimeterConfigPanel,
  },
  speedGraph: {
    label: 'Speed Graph',
    defaultConfig: { showMeasuringZone: true, showScoringZone: true, showLabel: false, showBackground: false, fadeIn: true },
    render: renderSpeedGraphWidget,
    renderPreview: renderSpeedGraphPreviewCard,
    configUI: buildSpeedGraphConfigPanel,
  },
  miniMap: {
    label: 'Mini Map',
    defaultConfig: { showBackground: true, showLabel: false, showExitMarker: true, fadeIn: true },
    render: renderMiniMapWidget,
    renderPreview: renderMiniMapPreviewCard,
    configUI: buildMiniMapConfigPanel,
  },
  gForce: {
    label: 'G-Force',
    defaultConfig: { showBackground: false, showLabel: false, fadeIn: true },
    render: renderGForceWidget,
    renderPreview: renderGForcePreviewCard,
    configUI: buildGForceConfigPanel,
  }
};

// ── Storage helpers ──
const STORAGE_KEY = 'flysight_jumps';

function getStoredJumps() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function storeJump(name, csvText) {
  const jumps = getStoredJumps();
  const existing = jumps.findIndex(j => j.name === name);
  if (existing >= 0) jumps[existing].csv = csvText;
  else jumps.push({ name, csv: csvText, addedAt: Date.now() });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(jumps));
}

function removeJump(name) {
  const jumps = getStoredJumps().filter(j => j.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(jumps));
}

// ── State ──
let currentJumpName = null;
let chartInstance = null;
let mapInstance = null;
let hoverMarker = null;

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
    chip.className = 'jump-chip' + (j.name === currentJumpName ? ' active' : '');
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
  currentJumpName = name;
  renderJumpList();
  renderCurrentJump();
}

function deleteJump(name) {
  removeJump(name);
  if (currentJumpName === name) {
    currentJumpName = null;
    document.getElementById('chartSection').style.display = 'none';
  }
  renderJumpList();
}

// ── CSV Parsing ──
function parseFlySightCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const cleaned = [lines[0], ...lines.slice(2)].join('\n');
  const result = Papa.parse(cleaned, { header: true, skipEmptyLines: true });
  return result.data;
}

function parseTimestamp(s) {
  const [datePart, timePart] = s.replace('Z','').split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, rest] = timePart.split(':');
  const [sec, frac] = rest.split('.');
  return new Date(y, mo-1, d, Number(h), Number(mi), Number(sec), Number(frac || 0) * 10).getTime();
}

function detectExitAndLanding(data) {
  const alts = data.map(r => parseFloat(r.hMSL));
  const veld = data.map(r => parseFloat(r.velD));
  const maxAlt = Math.max(...alts);
  const maxIdx = alts.indexOf(maxAlt);

  // Exit: sustained velD > 3 m/s
  let exitIdx = maxIdx;
  for (let i = maxIdx; i < data.length - 20; i++) {
    let sustained = true;
    for (let j = i; j < i + 20 && j < data.length; j++) {
      if (veld[j] <= 3) { sustained = false; break; }
    }
    if (sustained) { exitIdx = i; break; }
  }

  // Landing: alt near min and velD small
  const minAlt = Math.min(...alts.slice(maxIdx));
  let landingIdx = data.length - 1;
  for (let i = maxIdx; i < data.length; i++) {
    if (alts[i] < minAlt + 15 && Math.abs(veld[i]) < 1.0) {
      landingIdx = i;
      break;
    }
  }

  // Canopy opening: after exit, velD was high (freefall) then drops below 15 m/s sustained
  // Look for 10 consecutive points where velD < 15 after it was > 30
  let canopyIdx = landingIdx;
  let wasInFreefall = false;
  for (let i = exitIdx; i < data.length - 10; i++) {
    if (veld[i] > 30) wasInFreefall = true;
    if (wasInFreefall && veld[i] < 15) {
      let sustained = true;
      for (let j = i; j < i + 10 && j < data.length; j++) {
        if (veld[j] >= 15) { sustained = false; break; }
      }
      if (sustained) { canopyIdx = i; break; }
    }
  }

  return { exitIdx, landingIdx, canopyIdx };
}

// ── Main render ──
function renderCurrentJump(showFull) {
  const jumps = getStoredJumps();
  const jump = jumps.find(j => j.name === currentJumpName);
  if (!jump) return;

  const section = document.getElementById('chartSection');
  section.style.display = 'block';

  const data = parseFlySightCSV(jump.csv);
  if (data.length < 50) { section.innerHTML = '<p>Not enough data points.</p>'; return; }

  const firstT = parseTimestamp(data[0].time);
  const allTimes = data.map(r => (parseTimestamp(r.time) - firstT) / 1000);
  const allAlts = data.map(r => parseFloat(r.hMSL));
  const allVelD = data.map(r => parseFloat(r.velD));

  let startIdx = 0, endIdx = data.length - 1;

  // Always detect exit so we can use it as T=0
  const { exitIdx, landingIdx, canopyIdx } = detectExitAndLanding(data);
  const exitTime = allTimes[exitIdx];

  if (!showFull) {
    const beforeSec = 5;
    const afterSec = 5;
    const canopyTime = allTimes[canopyIdx];

    startIdx = allTimes.findIndex(t => t >= exitTime - beforeSec);
    endIdx = allTimes.findIndex(t => t >= canopyTime + afterSec);
    if (startIdx < 0) startIdx = 0;
    if (endIdx < 0) endIdx = data.length - 1;
  }

  // Slice the data — time is relative to EXIT (T=0 at exit)
  const times = [], altitudes = [], vertSpeeds = [], horzSpeeds = [], sliceLats = [], sliceLons = [], velNs = [], velEs = [];
  for (let i = startIdx; i <= endIdx; i++) {
    times.push(allTimes[i] - exitTime);
    altitudes.push(allAlts[i]);
    vertSpeeds.push(allVelD[i]);
    const vN = parseFloat(data[i].velN) || 0;
    const vE = parseFloat(data[i].velE) || 0;
    horzSpeeds.push(Math.sqrt(vN * vN + vE * vE));
    velNs.push(vN);
    velEs.push(vE);
    sliceLats.push(parseFloat(data[i].lat));
    sliceLons.push(parseFloat(data[i].lon));
  }

  // Stats — use full dataset for ground level and exit altitude, not the trimmed slice
  const exitAlt = allAlts[exitIdx];
  const groundAlt = allAlts[landingIdx]; // actual ground level from landing point in full data
  const maxFallSpeed = Math.max(...vertSpeeds);
  const maxSpeedKmh = (maxFallSpeed * 3.6).toFixed(0);

  // ── FAI Speed Skydiving Performance Window (rules section 2.3, 5.5) ──
  // Window starts when velD first reaches 10 m/s after exit
  // Window ends 7,400 ft (2,255.52m) below the WINDOW START alt, or at breakoff (5,600 ft AGL), whichever is higher
  const PERF_WINDOW_HEIGHT = 7400 * 0.3048; // 2255.52m
  const BREAKOFF_AGL = 5600 * 0.3048; // 1706.88m
  const breakoffAltMSL = groundAlt + BREAKOFF_AGL;

  // Find window start: interpolate where velD first crosses 10 m/s after exit
  const VELD_THRESHOLD = 10; // m/s
  let perfWindowStartTime = null;
  let perfWindowStartAlt = null;
  for (let i = 1; i < times.length; i++) {
    if (times[i] < 0) continue;
    if (vertSpeeds[i] >= VELD_THRESHOLD) {
      if (times[i - 1] >= 0 && vertSpeeds[i - 1] < VELD_THRESHOLD) {
        // Interpolate between bracketing points
        const frac = (VELD_THRESHOLD - vertSpeeds[i - 1]) / (vertSpeeds[i] - vertSpeeds[i - 1]);
        perfWindowStartTime = times[i - 1] + frac * (times[i] - times[i - 1]);
        perfWindowStartAlt = altitudes[i - 1] + frac * (altitudes[i] - altitudes[i - 1]);
      } else {
        // First post-exit point already >= threshold (no prior point to interpolate from)
        perfWindowStartTime = times[i];
        perfWindowStartAlt = altitudes[i];
      }
      break;
    }
  }

  // Window end: 7,400 ft below window start, or breakoff, whichever is higher
  const windowEndByDrop = perfWindowStartAlt !== null ? perfWindowStartAlt - PERF_WINDOW_HEIGHT : null;
  const perfWindowEndAlt = windowEndByDrop !== null ? Math.max(windowEndByDrop, breakoffAltMSL) : breakoffAltMSL;

  // Find window end time: first point where altitude drops to perfWindowEndAlt
  let perfWindowEndTime = null;
  for (let i = 0; i < times.length; i++) {
    if (times[i] >= 0 && altitudes[i] <= perfWindowEndAlt) {
      perfWindowEndTime = times[i];
      break;
    }
  }

  // Compute speed score: fastest altitude drop over exactly 3 seconds (FlySight Viewer algorithm)
  // Uses altitude displacement / time instead of averaging velD samples
  const TIME_DELTA = 0.005; // 5ms tolerance for 3-second window matching
  const SCORE_WINDOW = 3; // seconds
  const windowBottomAGL = BREAKOFF_AGL; // 1706.88m AGL
  const fromExit = PERF_WINDOW_HEIGHT; // 2255.52m below perf start altitude
  let speedScore = null;
  let best3sStart = null;
  let best3sEnd = null;
  if (perfWindowStartTime !== null && perfWindowEndTime !== null) {
    // Convert to AGL for constraint checks
    const altsAGL = altitudes.map(a => a - groundAlt);
    const perfStartAltAGL = perfWindowStartAlt - groundAlt;

    let maxScore = 0;
    let iStart = times.length - 1;

    // Scan backward through data points (matching FlySight Viewer algorithm)
    for (let iEnd = times.length - 1; iEnd >= 0; iEnd--) {
      const tStart = times[iEnd] - SCORE_WINDOW;

      // Move iStart backward (to earlier times) while it's too late
      while (iStart >= 0 && times[iStart] > tStart + TIME_DELTA) {
        iStart--;
      }

      if (iStart < 0) break;
      if (times[iStart] < 0) break; // start point before exit

      // Altitude constraints (AGL)
      if (altsAGL[iEnd] < perfStartAltAGL - fromExit) continue; // below from-exit limit
      if (altsAGL[iEnd] < windowBottomAGL) continue; // below breakoff

      // Ensure exactly 3s apart (within tolerance)
      if (times[iStart] < tStart - TIME_DELTA) continue;

      const score = (altsAGL[iStart] - altsAGL[iEnd]) / (times[iEnd] - times[iStart]);
      if (score > maxScore) {
        maxScore = score;
        best3sStart = times[iStart];
        best3sEnd = times[iEnd];
      }
    }
    if (maxScore > 0) speedScore = maxScore * 3.6; // convert m/s to km/h
  }

  // Cache speed score for chip display (stored separately to avoid re-serializing CSVs)
  try {
    const scores = JSON.parse(localStorage.getItem('flysight_scores') || '{}');
    scores[currentJumpName] = speedScore;
    localStorage.setItem('flysight_scores', JSON.stringify(scores));
  } catch (e) { /* ignore storage errors */ }
  renderJumpList();

  const dateStr = data[0].time ? data[0].time.split('T')[0] : '';
  document.getElementById('chartTitle').textContent = dateStr + ' — ' + currentJumpName;

  // ── Exit altitude validation (FAI rules 5.3) ──
  // Valid: 3,962m (13,000 ft) to 4,267m (14,000 ft) AGL
  const exitAltAGL = exitAlt - groundAlt;
  const EXIT_MIN_AGL = 3962;
  const EXIT_MAX_AGL = 4267;
  const exitValid = exitAltAGL >= EXIT_MIN_AGL && exitAltAGL <= EXIT_MAX_AGL;
  const exitTooHigh = exitAltAGL > EXIT_MAX_AGL;
  const exitTooLow = exitAltAGL < EXIT_MIN_AGL;

  const exitAltAGLft = (exitAltAGL * 3.28084).toFixed(0);

  let exitBadgeClass, exitBadgeIcon, exitTooltip;
  if (exitValid) {
    exitBadgeClass = 'badge-valid';
    exitBadgeIcon = '&#10003;';
    exitTooltip = `Valid — max ${EXIT_MAX_AGL}m / 14,000 ft AGL`;
  } else if (exitTooHigh) {
    exitBadgeClass = 'badge-invalid';
    exitBadgeIcon = '&#9888;';
    exitTooltip = `Too high — max ${EXIT_MAX_AGL}m / 14,000 ft AGL`;
  } else {
    exitBadgeClass = 'badge-invalid';
    exitBadgeIcon = '&#9888;';
    exitTooltip = `Too low — min ${EXIT_MIN_AGL}m / 13,000 ft AGL`;
  }

  const speedScoreHtml = speedScore !== null
    ? `<div class="stat-card">
        <div class="stat-label">Speed Score (3s)</div>
        <div class="stat-value alt">${speedScore.toFixed(2)} km/h</div>
      </div>`
    : '';

  document.getElementById('stats').innerHTML = `
    <div class="stat-card" style="position:relative;">
      <span class="exit-badge ${exitBadgeClass}">
        ${exitBadgeIcon}
        <span class="exit-tooltip">${exitTooltip.replace('\n', '<br>')}</span>
      </span>
      <div class="stat-label">Exit Altitude</div>
      <div class="stat-value alt">${exitAlt.toFixed(0)} m / ${(exitAlt * 3.28084).toFixed(0)} ft</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Max Vertical Speed</div>
      <div class="stat-value alt">${maxSpeedKmh} km/h / ${(maxFallSpeed * 2.23694).toFixed(0)} mph</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Landing Altitude</div>
      <div class="stat-value alt">${groundAlt.toFixed(0)} m / ${(groundAlt * 3.28084).toFixed(0)} ft</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Speed Window</div>
      <div class="stat-detail alt"><span class="stat-detail-label">Start</span> ${perfWindowStartAlt !== null ? perfWindowStartAlt.toFixed(0) + ' m / ' + (perfWindowStartAlt * 3.28084).toFixed(0) + ' ft' : '—'}</div>
      <div class="stat-detail alt"><span class="stat-detail-label">End</span> ${perfWindowEndAlt.toFixed(0)} m / ${(perfWindowEndAlt * 3.28084).toFixed(0)} ft</div>
    </div>
    ${speedScoreHtml}
  `;

  // ── Chart ──
  if (chartInstance) chartInstance.destroy();

  const ctx = document.getElementById('chart').getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: times,
      datasets: [
        {
          label: 'Altitude (m)',
          data: altitudes,
          borderColor: '#38bdf8',
          backgroundColor: 'rgba(56,189,248,0.08)',
          fill: true,
          yAxisID: 'yAlt',
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.2,
          order: 2
        },
        {
          label: 'Vertical Speed (km/h)',
          data: vertSpeeds.map(v => v * 3.6),
          borderColor: '#f472b6',
          backgroundColor: 'rgba(244,114,182,0.08)',
          fill: false,
          yAxisID: 'ySpeed',
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.2,
          order: 1
        },
        {
          label: 'Ground Speed (km/h)',
          data: horzSpeeds.map(v => v * 3.6),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.08)',
          fill: false,
          yAxisID: 'ySpeed',
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.2,
          order: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2.5,
      interaction: { mode: 'index', intersect: false },
      onHover: function(event, elements) {
        if (elements.length > 0 && mapInstance) {
          const idx = elements[0].index;
          const lat = sliceLats[idx];
          const lon = sliceLons[idx];
          if (!isNaN(lat) && !isNaN(lon)) {
            if (!hoverMarker) {
              hoverMarker = L.circleMarker([lat, lon], {
                radius: 7, fillColor: '#fff', color: '#0f172a', weight: 2, fillOpacity: 1
              }).addTo(mapInstance);
            } else {
              hoverMarker.setLatLng([lat, lon]);
            }
          }
        }
      },
      plugins: {
        annotation: {
          annotations: {
            exitLine: {
              type: 'line',
              xMin: 0,
              xMax: 0,
              borderColor: '#94a3b8',
              borderWidth: 2,
              borderDash: [6, 4],
              label: {
                display: true,
                content: 'EXIT',
                position: 'start',
                backgroundColor: 'rgba(148,163,184,0.15)',
                color: '#94a3b8',
                font: { size: 11, weight: 'bold' },
                padding: 4
              }
            },
            ...(perfWindowEndTime !== null ? {
              windowEndLine: {
                type: 'line',
                xMin: perfWindowEndTime,
                xMax: perfWindowEndTime,
                borderColor: '#94a3b8',
                borderWidth: 1.5,
                borderDash: [4, 3],
                label: {
                  display: true,
                  content: 'WINDOW END',
                  position: 'start',
                  backgroundColor: 'rgba(148,163,184,0.15)',
                  color: '#94a3b8',
                  font: { size: 10, weight: 'bold' },
                  padding: 3
                }
              }
            } : {}),
            ...(best3sStart !== null ? {
              best3sZone: {
                type: 'box',
                xMin: best3sStart,
                xMax: best3sEnd,
                backgroundColor: 'rgba(255,255,255,0.06)',
                borderColor: 'rgba(255,255,255,0.15)',
                borderWidth: 1,
                label: {
                  display: true,
                  content: 'BEST 3s',
                  position: { x: 'center', y: 'start' },
                  color: 'rgba(255,255,255,0.5)',
                  font: { size: 9, weight: 'bold' },
                  padding: 3
                }
              }
            } : {})
          }
        },
        legend: {
          labels: { color: '#cbd5e1', font: { size: 13 }, usePointStyle: true, pointStyle: 'line' }
        },
        tooltip: {
          backgroundColor: '#1e293b',
          titleColor: '#f8fafc',
          bodyColor: '#cbd5e1',
          borderColor: '#334155',
          borderWidth: 1,
          callbacks: {
            title: function(items) {
              const sec = items[0].parsed.x;
              const abs = Math.abs(sec);
              const m = Math.floor(abs / 60);
              const s = Math.floor(abs % 60);
              const sign = sec < 0 ? '- ' : '+ ';
              return 'T' + sign + m + ':' + s.toString().padStart(2,'0');
            },
            label: function(ctx) {
              if (ctx.datasetIndex === 0) {
                const m = ctx.parsed.y;
                return ' Altitude: ' + m.toFixed(0) + ' m (' + (m * 3.28084).toFixed(0) + ' ft)';
              } else if (ctx.datasetIndex === 1) {
                return ' Vert Speed: ' + ctx.parsed.y.toFixed(0) + ' km/h';
              } else {
                return ' Ground Speed: ' + ctx.parsed.y.toFixed(0) + ' km/h';
              }
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Time (seconds)', color: '#94a3b8' },
          ticks: {
            color: '#64748b',
            callback: v => {
              const abs = Math.abs(v);
              const m = Math.floor(abs / 60);
              const s = Math.floor(abs % 60);
              const sign = v < 0 ? '-' : '';
              return sign + m + ':' + s.toString().padStart(2,'0');
            }
          },
          grid: { color: 'rgba(148,163,184,0.08)' }
        },
        yAlt: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: 'Altitude (m)', color: '#38bdf8' },
          ticks: { color: '#38bdf8' },
          grid: { color: 'rgba(56,189,248,0.08)' }
        },
        ySpeed: {
          type: 'linear',
          position: 'right',
          title: { display: true, text: 'Speed (km/h)', color: '#f472b6' },
          ticks: { color: '#f472b6' },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });

  // ── Map ──
  const pathCoords = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const lat = parseFloat(data[i].lat);
    const lon = parseFloat(data[i].lon);
    if (!isNaN(lat) && !isNaN(lon)) pathCoords.push([lat, lon]);
  }

  const exitLat = parseFloat(data[exitIdx].lat);
  const exitLon = parseFloat(data[exitIdx].lon);
  const landLat = parseFloat(data[landingIdx].lat);
  const landLon = parseFloat(data[landingIdx].lon);

  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  hoverMarker = null;

  mapInstance = L.map('map', { attributionControl: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19
  }).addTo(mapInstance);

  // Flight path — blue (plane), red (freefall), black (canopy)
  const exitPathIdx = exitIdx - startIdx;
  const canopyPathIdx = canopyIdx - startIdx;

  for (let i = 0; i < pathCoords.length - 1; i++) {
    let color;
    if (i < exitPathIdx) color = '#38bdf8';       // blue — in the plane
    else if (i < canopyPathIdx) color = '#ef4444'; // red — freefall
    else color = '#1e1e1e';                        // black — under canopy
    L.polyline([pathCoords[i], pathCoords[i + 1]], {
      color,
      weight: 3,
      opacity: 0.9
    }).addTo(mapInstance);
  }

  // Airplane heading line — computed from 3 seconds before exit
  const exitTimeAbs = allTimes[exitIdx];
  // Find the point ~3 seconds before exit in the full dataset
  let headingRefIdx = exitIdx;
  for (let i = exitIdx; i >= 0; i--) {
    if (exitTimeAbs - allTimes[i] >= 3) { headingRefIdx = i; break; }
  }
  const refLat = parseFloat(data[headingRefIdx].lat);
  const refLon = parseFloat(data[headingRefIdx].lon);

  if (!isNaN(refLat) && !isNaN(refLon) && !isNaN(exitLat) && !isNaN(exitLon) && headingRefIdx !== exitIdx) {
    const dLat = exitLat - refLat;
    const dLon = exitLon - refLon;
    // Extend the line well beyond the exit point in both directions
    const extendFactor = 8;
    const lineStart = [exitLat - dLat * extendFactor, exitLon - dLon * extendFactor];
    const lineEnd = [exitLat + dLat * extendFactor, exitLon + dLon * extendFactor];
    L.polyline([lineStart, lineEnd], {
      color: '#94a3b8',
      weight: 3,
      dashArray: '8, 8',
      opacity: 0.7
    }).addTo(mapInstance);
  }

  // Exit marker
  if (!isNaN(exitLat) && !isNaN(exitLon)) {
    L.circleMarker([exitLat, exitLon], {
      radius: 8, fillColor: '#facc15', color: '#000', weight: 2, fillOpacity: 1
    }).addTo(mapInstance).bindTooltip('Exit', { permanent: true, direction: 'top', className: 'map-label' });
  }

  // Landing marker
  if (!isNaN(landLat) && !isNaN(landLon)) {
    L.circleMarker([landLat, landLon], {
      radius: 8, fillColor: '#4ade80', color: '#000', weight: 2, fillOpacity: 1
    }).addTo(mapInstance).bindTooltip('Landing', { permanent: true, direction: 'top', className: 'map-label' });
  }

  if (pathCoords.length > 1) {
    mapInstance.fitBounds(L.latLngBounds(pathCoords).pad(0.15));
  }

  // Expose flight data for video overlay sync
  currentFlightData = { times, altitudes, vertSpeeds, horzSpeeds, lats: sliceLats, lons: sliceLons, velNs, velEs, exitIdx: exitIdx - startIdx, canopyIdx: canopyIdx - startIdx, speedScore, perfWindowStartTime, perfWindowEndTime, best3sStart, best3sEnd };
}

// ── Video Overlay ──

function openVideoModal() {
  if (!currentJumpName) return;
  document.getElementById('videoModal').classList.add('open');
}

function closeVideoModal() {
  document.getElementById('videoModal').classList.remove('open');
  const v = document.getElementById('videoPreview');
  if (v && !v.paused) v.pause();
}

// Close modal on backdrop click or Escape
document.getElementById('videoModal').addEventListener('click', function(e) {
  if (e.target === this) closeVideoModal();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('videoModal').classList.contains('open')) closeVideoModal();
});

// Video dropzone
(function() {
  const dz = document.getElementById('videoDropzone');
  const fi = document.getElementById('videoFileInput');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleVideoFile(e.dataTransfer.files[0]);
  });
  fi.addEventListener('change', () => { if (fi.files.length) handleVideoFile(fi.files[0]); });
})();

function handleVideoFile(file) {
  if (videoObjectURL) URL.revokeObjectURL(videoObjectURL);
  videoObjectURL = URL.createObjectURL(file);
  const video = document.getElementById('videoPreview');
  video.src = videoObjectURL;
  video.muted = true;
  video.load();
  video.addEventListener('loadedmetadata', function onMeta() {
    video.removeEventListener('loadedmetadata', onMeta);
    document.getElementById('videoDuration').textContent = '/ ' + formatVideoTimecode(video.duration);
    document.getElementById('videoScrubber').max = Math.floor(video.duration * 1000);
    document.getElementById('videoStep1').style.display = 'none';
    document.getElementById('videoStep2').style.display = 'block';
    // Reset exit
    videoExitTime = null;
    document.getElementById('videoExitTimecode').textContent = 'Not set';
    document.getElementById('videoExitManual').value = '';
  });
  video.addEventListener('error', function() {
    alert('Could not load this video file. Try a different format (MP4, WebM).');
  }, { once: true });
}

// Playback controls
function toggleVideoPlay() {
  const v = document.getElementById('videoPreview');
  if (v.paused) {
    v.play();
    document.getElementById('videoPlayBtn').textContent = 'Pause';
  } else {
    v.pause();
    document.getElementById('videoPlayBtn').textContent = 'Play';
  }
}

(function() {
  const video = document.getElementById('videoPreview');
  const scrubber = document.getElementById('videoScrubber');
  video.addEventListener('timeupdate', () => {
    document.getElementById('videoTimecode').textContent = formatVideoTimecode(video.currentTime);
    scrubber.value = Math.floor(video.currentTime * 1000);
    drawOverlayPreview();
  });
  video.addEventListener('ended', () => {
    document.getElementById('videoPlayBtn').textContent = 'Play';
  });
  scrubber.addEventListener('input', () => {
    video.currentTime = scrubber.value / 1000;
  });
})();

function formatVideoTimecode(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(3);
  return m + ':' + s.padStart(6, '0');
}

// Exit sync
function markVideoExit() {
  const v = document.getElementById('videoPreview');
  videoExitTime = v.currentTime;
  document.getElementById('videoExitTimecode').textContent = formatVideoTimecode(videoExitTime);
  document.getElementById('widgetsSection').style.display = '';
  document.getElementById('exportSection').style.display = '';
  drawOverlayPreview();
}



// Map video time to flight data index
function videoTimeToDataIndex(videoTime) {
  if (videoExitTime === null || !currentFlightData) return -1;
  const flightTime = videoTime - videoExitTime; // seconds relative to exit
  const { times } = currentFlightData;
  let closest = 0, minDiff = Math.abs(times[0] - flightTime);
  for (let i = 1; i < times.length; i++) {
    const diff = Math.abs(times[i] - flightTime);
    if (diff < minDiff) { minDiff = diff; closest = i; }
    else break; // times are sorted, once diff increases we passed the closest
  }
  return closest;
}

// Safe radio value reader with fallback
function getRadioValue(name, fallback) {
  const el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : fallback;
}

// ── Video content area helper ──
function getVideoContentRect() {
  const video = document.getElementById('videoPreview');
  const elemW = video.clientWidth, elemH = video.clientHeight;
  const vidAspect = video.videoWidth / video.videoHeight;
  const elemAspect = elemW / elemH;
  let contentW, contentH;
  if (vidAspect > elemAspect) {
    contentW = elemW; contentH = elemW / vidAspect;
  } else {
    contentH = elemH; contentW = elemH * vidAspect;
  }
  const offX = (elemW - contentW) / 2;
  const offY = (elemH - contentH) / 2;
  return { offX, offY, contentW, contentH, elemW, elemH };
}

// ── Widget helpers ──
function createWidget(type, x, y) {
  const def = WIDGET_TYPES[type];
  if (!def) return null;
  const w = {
    id: nextWidgetId++,
    type: type,
    x: x,
    y: y,
    widgetScale: 1.0, // per-widget scale multiplier (adjusted by resize handles)
    config: Object.assign({}, def.defaultConfig),
  };
  widgets.push(w);
  return w;
}

function removeWidget(id) {
  widgets = widgets.filter(w => w.id !== id);
  if (selectedWidgetId === id) {
    selectedWidgetId = null;
    updateWidgetSettingsPanel();
  }
  drawOverlayPreview();
}

// ── Info widget renderer ──
function getInfoLines(dataIdx, units, config) {
  const fd = currentFlightData;
  const alt = fd.altitudes[dataIdx];
  const vSpeed = fd.vertSpeeds[dataIdx];
  const t = fd.times[dataIdx];
  const lines = [], colors = [], labels = [];

  if (config.showTime) {
    const sign = t < 0 ? '- ' : '+ ';
    const absT = Math.abs(t);
    const tMin = Math.floor(absT / 60);
    const tSec = Math.floor(absT % 60);
    lines.push(tMin + ':' + tSec.toString().padStart(2, '0'));
    colors.push('#f8fafc');
    labels.push('TIME');
  }

  if (config.showAltitude) {
    if (units === 'metric') lines.push(alt.toFixed(0) + ' m');
    else if (units === 'imperial') lines.push((alt * 3.28084).toFixed(0) + ' ft');
    else lines.push(alt.toFixed(0) + ' m / ' + (alt * 3.28084).toFixed(0) + ' ft');
    colors.push('#f8fafc');
    labels.push('ALTITUDE');
  }

  if (config.showSpeed) {
    if (units === 'metric') lines.push((vSpeed * 3.6).toFixed(0) + ' km/h');
    else if (units === 'imperial') lines.push((vSpeed * 2.23694).toFixed(0) + ' mph');
    else lines.push((vSpeed * 3.6).toFixed(0) + ' km/h / ' + (vSpeed * 2.23694).toFixed(0) + ' mph');
    colors.push('#f8fafc');
    labels.push('VERT. SPEED');
  }

  if (config.showHSpeed) {
    const hSpeed = fd.horzSpeeds[dataIdx];
    if (units === 'metric') lines.push((hSpeed * 3.6).toFixed(0) + ' km/h');
    else if (units === 'imperial') lines.push((hSpeed * 2.23694).toFixed(0) + ' mph');
    else lines.push((hSpeed * 3.6).toFixed(0) + ' km/h / ' + (hSpeed * 2.23694).toFixed(0) + ' mph');
    colors.push('#f8fafc');
    labels.push('HORIZ. SPEED');
  }

  if (config.showScore && fd.speedScore && fd.perfWindowEndTime !== null && t > fd.perfWindowEndTime) {
    lines.push('Score: ' + fd.speedScore.toFixed(2) + ' km/h');
    colors.push('#4ade80');
    labels.push('SPEED SCORE');
  }

  return { lines, colors, labels };
}

function getSampleInfoLines(units, config) {
  const lines = [], colors = [], labels = [];
  if (config.showTime) { lines.push('0:42'); colors.push('#f8fafc'); labels.push('TIME'); }
  if (config.showAltitude) {
    if (units === 'metric') lines.push('3,200 m');
    else if (units === 'imperial') lines.push('10,498 ft');
    else lines.push('3,200 m / 10,498 ft');
    colors.push('#f8fafc');
    labels.push('ALTITUDE');
  }
  if (config.showSpeed) {
    if (units === 'metric') lines.push('412 km/h');
    else if (units === 'imperial') lines.push('256 mph');
    else lines.push('412 km/h / 256 mph');
    colors.push('#f8fafc');
    labels.push('VERT. SPEED');
  }
  if (config.showHSpeed) {
    if (units === 'metric') lines.push('85 km/h');
    else if (units === 'imperial') lines.push('53 mph');
    else lines.push('85 km/h / 53 mph');
    colors.push('#f8fafc');
    labels.push('HORIZ. SPEED');
  }
  if (config.showScore) { lines.push('Score: 487.32 km/h'); colors.push('#4ade80'); labels.push('SPEED SCORE'); }
  return { lines, colors, labels };
}

function computeInfoBoxSize(ctx, contentRect, lines, scale, labels) {
  const fontSize = Math.round(contentRect.height * 0.035 * (scale || 1));
  const labelFontSize = Math.round(fontSize * 0.55);
  ctx.font = 'bold ' + fontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'top';

  const hasLabels = labels && labels.length;
  const labelHeight = hasLabels ? labelFontSize * 1.2 : 0;
  const itemHeight = fontSize * 1.2 + labelHeight;
  const itemGap = hasLabels ? fontSize * 0.35 : 0;
  const padding = fontSize * 0.6;
  const maxWidth = Math.max(...lines.map(l => ctx.measureText(l).width));
  const boxW = maxWidth + padding * 2;
  const boxH = lines.length * itemHeight + (lines.length - 1) * itemGap + padding * 2;

  return { boxW, boxH, fontSize, labelFontSize, labelHeight, itemHeight, itemGap, padding };
}

function renderInfoWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const config = widget.config;
  const widgetUnits = config.units || units || 'both';
  let lines, colors, labels;
  if (dataIdx >= 0 && currentFlightData && dataIdx < currentFlightData.times.length) {
    ({ lines, colors, labels } = getInfoLines(dataIdx, widgetUnits, config));
  } else {
    ({ lines, colors, labels } = getSampleInfoLines(widgetUnits, config));
  }
  if (!lines.length) return;

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  const effectiveScale = widget.widgetScale || 1;
  const p = computeInfoBoxSize(ctx, contentRect, lines, effectiveScale, labels);
  // Position from widget center (fractional)
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const x = cx - p.boxW / 2;
  const y = cy - p.boxH / 2;

  // Store computed bounds for hit-testing
  widget._bounds = { x: x, y: y, w: p.boxW, h: p.boxH };

  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, p.boxW, p.boxH, p.fontSize * 0.3);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, p.boxW, p.boxH);
  }

  lines.forEach((line, i) => {
    const itemY = y + p.padding + i * (p.itemHeight + p.itemGap);
    if (labels && labels[i]) {
      ctx.font = '600 ' + p.labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(labels[i], x + p.padding, itemY);
    }
    ctx.font = 'bold ' + p.fontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = (colors && colors[i]) || '#f8fafc';
    ctx.fillText(line, x + p.padding, itemY + p.labelHeight);
  });

  ctx.restore();
}

function renderInfoPreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const sampleLines = ['0:42', '3,200 m', '412 km/h'];
  const sampleColors = ['#f8fafc', '#f8fafc', '#f8fafc'];
  const sampleLabels = ['TIME', 'ALTITUDE', 'VERT. SPEED'];
  // Draw as if widget is centered in the preview
  const fakeWidget = { x: 0.5, y: 0.5, config: {} };
  const contentRect = { width: canvas.width, height: canvas.height };
  const p = computeInfoBoxSize(ctx, contentRect, sampleLines, 3, sampleLabels);
  const x = (canvas.width - p.boxW) / 2;
  const y = (canvas.height - p.boxH) / 2;

  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, p.boxW, p.boxH, p.fontSize * 0.3);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, p.boxW, p.boxH);
  }
  sampleLines.forEach((line, i) => {
    const itemY = y + p.padding + i * (p.itemHeight + p.itemGap);
    if (sampleLabels[i]) {
      ctx.font = '600 ' + p.labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(sampleLabels[i], x + p.padding, itemY);
    }
    ctx.font = 'bold ' + p.fontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = sampleColors[i] || '#f8fafc';
    ctx.fillText(line, x + p.padding, itemY + p.labelHeight);
  });
}

function buildInfoConfigPanel(widget) {
  const wrap = document.createElement('div');

  // Show checkboxes
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showTime', label: 'Time (T+/-)' },
    { key: 'showAltitude', label: 'Altitude' },
    { key: 'showSpeed', label: 'Vertical speed' },
    { key: 'showHSpeed', label: 'Horizontal speed' },
    { key: 'showScore', label: 'Speed score (after window)' },
    { key: 'fadeIn', label: 'Fade in before exit' },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  wrap.appendChild(checks);

  // Units
  wrap.appendChild(buildUnitsConfig(widget));

  return wrap;
}

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
    });
    lbl.appendChild(rb);
    lbl.appendChild(document.createTextNode(' ' + label));
    radios.appendChild(lbl);
  });
  group.appendChild(radios);
  return group;
}

// ── Speed widget renderer ──
function renderSpeedWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const config = widget.config;
  const unitSys = config.units || units || 'both';

  // Get speed value
  let speedMs = 0;
  let isSample = false;
  if (dataIdx >= 0 && currentFlightData && dataIdx < currentFlightData.times.length) {
    if (config.dataSource === 'horzSpeed') {
      speedMs = currentFlightData.horzSpeeds[dataIdx];
    } else {
      speedMs = currentFlightData.vertSpeeds[dataIdx];
    }
  } else {
    speedMs = 114.4; // ~412 km/h sample
    isSample = true;
  }

  // Convert to display units
  let speedDisplay, unitLabel, maxValue;
  if (unitSys === 'imperial') {
    speedDisplay = speedMs * 2.23694;
    unitLabel = 'MPH';
    maxValue = 350;
  } else {
    speedDisplay = speedMs * 3.6;
    unitLabel = unitSys === 'both' ? 'KPH' : 'KPH';
    maxValue = 550;
  }

  const effectiveScale = widget.widgetScale || 1;
  const size = contentRect.height * 0.25 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;

  // Store bounds for hit-testing (square bounding box)
  widget._bounds = { x: cx - size / 2, y: cy - size / 2, w: size, h: size };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  const radius = size * 0.38;
  const strokeW = size * 0.06;
  const startAngle = (135 * Math.PI) / 180;
  const endAngle = (405 * Math.PI) / 180;
  const sweepAngle = (270 * Math.PI) / 180;
  const valueFraction = Math.min(Math.max(speedDisplay / maxValue, 0), 1);
  const needleAngle = startAngle + valueFraction * sweepAngle;

  // Optional background
  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(cx - size / 2, cy - size / 2, size, size, size * 0.06);
      ctx.fill();
    } else {
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    }
  }

  // Inactive arc
  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.05, radius, startAngle, endAngle);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
  ctx.lineWidth = strokeW;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Active arc
  if (valueFraction > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy - size * 0.05, radius, startAngle, needleAngle);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = strokeW;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Needle dot at tip of active arc
  if (valueFraction > 0) {
    const dotX = cx + radius * Math.cos(needleAngle);
    const dotY = (cy - size * 0.05) + radius * Math.sin(needleAngle);
    ctx.beginPath();
    ctx.arc(dotX, dotY, strokeW * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
  }

  // Speed number
  const numFontSize = size * 0.22;
  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(Math.round(speedDisplay).toString(), cx, cy + size * 0.12);

  // Unit label
  const unitFontSize = size * 0.09;
  ctx.font = '600 ' + unitFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(unitLabel, cx, cy + size * 0.12 + numFontSize * 0.7);

  // Optional label inside the gauge, above the speed number
  if (config.showLabel) {
    const labelText = config.dataSource === 'horzSpeed' ? 'HORIZ' : 'VERT';
    const labelFontSize = size * 0.07;
    ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, cx, cy + size * 0.12 - numFontSize * 0.65);
  }

  ctx.restore();
}

function drawSpeedPreviewCard(ctx, canvas, speedText, fraction) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const size = canvas.height * 0.85;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = size * 0.38;
  const strokeW = size * 0.06;
  const startAngle = (135 * Math.PI) / 180;
  const endAngle = (405 * Math.PI) / 180;
  const needleAngle = startAngle + fraction * (270 * Math.PI / 180);

  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.05, radius, startAngle, endAngle);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
  ctx.lineWidth = strokeW;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.05, radius, startAngle, needleAngle);
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = strokeW;
  ctx.lineCap = 'round';
  ctx.stroke();

  const numFontSize = size * 0.22;
  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(speedText, cx, cy + size * 0.12);

  const unitFontSize = size * 0.09;
  ctx.font = '600 ' + unitFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('KPH', cx, cy + size * 0.12 + numFontSize * 0.7);
}

function renderVertSpeedPreviewCard(ctx, canvas) {
  drawSpeedPreviewCard(ctx, canvas, '412', 0.75);
}

function renderHorzSpeedPreviewCard(ctx, canvas) {
  drawSpeedPreviewCard(ctx, canvas, '85', 0.15);
}

function buildSpeedConfigPanel(widget) {
  const wrap = document.createElement('div');

  // Checkboxes
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: 'Show label' },
    { key: 'showBackground', label: 'Show background' },
    { key: 'fadeIn', label: 'Fade in before exit' },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  wrap.appendChild(checks);

  // Units (no "both" for speed gauges — they only show one value)
  wrap.appendChild(buildUnitsConfig(widget, [
    { value: 'metric', label: 'Metric' },
    { value: 'imperial', label: 'Imperial' },
  ]));

  return wrap;
}

// ── Altitude graph widget ──
function renderAltGraphWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const fd = currentFlightData;
  const config = widget.config;
  const effectiveScale = widget.widgetScale || 1;
  const w = contentRect.width * 0.3 * effectiveScale;
  const h = contentRect.height * 0.2 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const x = cx - w / 2;
  const y = cy - h / 2;

  widget._bounds = { x, y, w, h };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  // Optional background
  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h * 0.06);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }

  // If no flight data, draw placeholder
  if (!fd || !fd.times || fd.times.length < 2) {
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.3);
    ctx.quadraticCurveTo(x + w * 0.3, y + h * 0.1, x + w * 0.5, y + h * 0.5);
    ctx.quadraticCurveTo(x + w * 0.7, y + h * 0.8, x + w, y + h * 0.9);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const times = fd.times;
  const alts = fd.altitudes;
  const minT = times[0], maxT = times[times.length - 1];
  const minAlt = Math.min(...alts), maxAlt = Math.max(...alts);
  const tRange = maxT - minT || 1;
  const altRange = maxAlt - minAlt || 1;
  const pad = 4;

  function tx(t) { return x + pad + (t - minT) / tRange * (w - pad * 2); }
  function ty(a) { return y + h - pad - (a - minAlt) / altRange * (h - pad * 2); }

  // Measuring zone (perf window start -> end)
  if (config.showMeasuringZone && fd.perfWindowStartTime !== null && fd.perfWindowEndTime !== null) {
    const zx1 = tx(fd.perfWindowStartTime);
    const zx2 = tx(fd.perfWindowEndTime);
    ctx.fillStyle = 'rgba(250, 204, 21, 0.12)';
    ctx.fillRect(zx1, y, zx2 - zx1, h);
    // Borders
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(zx1, y); ctx.lineTo(zx1, y + h);
    ctx.moveTo(zx2, y); ctx.lineTo(zx2, y + h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Scoring zone (best 3s window)
  if (config.showScoringZone && fd.best3sStart !== null && fd.best3sEnd !== null) {
    const sx1 = tx(fd.best3sStart);
    const sx2 = tx(fd.best3sEnd);
    ctx.fillStyle = 'rgba(74, 222, 128, 0.15)';
    ctx.fillRect(sx1, y, sx2 - sx1, h);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx1, y); ctx.lineTo(sx1, y + h);
    ctx.moveTo(sx2, y); ctx.lineTo(sx2, y + h);
    ctx.stroke();
  }

  // Altitude line
  ctx.beginPath();
  for (let i = 0; i < times.length; i++) {
    const px = tx(times[i]);
    const py = ty(alts[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5 * effectiveScale;
  ctx.stroke();

  // Fill under the line
  ctx.lineTo(tx(times[times.length - 1]), y + h - pad);
  ctx.lineTo(tx(times[0]), y + h - pad);
  ctx.closePath();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
  ctx.fill();

  // Current position marker
  if (dataIdx >= 0 && dataIdx < times.length) {
    const mx = tx(times[dataIdx]);
    const my = ty(alts[dataIdx]);
    ctx.beginPath();
    ctx.arc(mx, my, 3 * effectiveScale, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();

    // Vertical time cursor
    ctx.strokeStyle = 'rgba(248, 250, 252, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx, y);
    ctx.lineTo(mx, y + h);
    ctx.stroke();
  }

  // Optional label
  if (config.showLabel) {
    const labelFontSize = h * 0.12;
    ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('ALTITUDE', x + pad, y + h - pad);
  }

  ctx.restore();
}

function renderAltGraphPreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width - 16;
  const h = canvas.height - 16;
  const x = 8, y = 8;

  // Fake altitude curve
  ctx.beginPath();
  const pts = [0.2, 0.15, 0.1, 0.12, 0.15, 0.3, 0.5, 0.65, 0.8, 0.88, 0.92];
  for (let i = 0; i < pts.length; i++) {
    const px = x + (i / (pts.length - 1)) * w;
    const py = y + pts[i] * h;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Fill
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
  ctx.fill();

  // Yellow zone
  ctx.fillStyle = 'rgba(250, 204, 21, 0.15)';
  ctx.fillRect(x + w * 0.25, y, w * 0.45, h);
}

function buildAltGraphConfigPanel(widget) {
  const wrap = document.createElement('div');
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: 'Show label' },
    { key: 'showBackground', label: 'Show background' },
    { key: 'showMeasuringZone', label: 'Show measuring zone' },
    { key: 'showScoringZone', label: 'Show scoring zone' },
    { key: 'fadeIn', label: 'Fade in before exit' },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  wrap.appendChild(checks);
  return wrap;
}

// ── Altimeter dial widget ──
function renderAltimeterWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const config = widget.config;
  const unitSys = config.units || 'metric';
  const fd = currentFlightData;

  let altM = 0, groundAlt = 0, maxAlt = 4000, isSample = false;
  if (dataIdx >= 0 && fd && fd.altitudes && dataIdx < fd.altitudes.length) {
    altM = fd.altitudes[dataIdx];
    groundAlt = Math.min(...fd.altitudes);
    maxAlt = Math.max(...fd.altitudes);
  } else {
    altM = 3200; groundAlt = 0; maxAlt = 4000; isSample = true;
  }

  const agl = altM - groundAlt;
  const maxAgl = maxAlt - groundAlt || 1;

  let altDisplay, unitLabel;
  if (unitSys === 'imperial') {
    altDisplay = Math.round(agl * 3.28084);
    unitLabel = 'FT';
  } else {
    altDisplay = Math.round(agl);
    unitLabel = 'M';
  }

  const effectiveScale = widget.widgetScale || 1;
  const size = contentRect.height * 0.25 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  widget._bounds = { x: cx - size / 2, y: cy - size / 2, w: size, h: size };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  const radius = size * 0.38;
  const strokeW = size * 0.06;
  const startAngle = (135 * Math.PI) / 180;
  const sweepAngle = (270 * Math.PI) / 180;
  const endAngle = startAngle + sweepAngle;
  const arcCy = cy - size * 0.05;

  // Optional background
  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(cx - size / 2, cy - size / 2, size, size, size * 0.06);
      ctx.fill();
    } else {
      ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    }
  }

  // Color zone thresholds in AGL meters
  const redThresh = 500, yellowThresh = 1000;
  const redFrac = Math.min(redThresh / maxAgl, 1);
  const yellowFrac = Math.min(yellowThresh / maxAgl, 1);

  // Draw colored arc zones (red, yellow, green)
  const zones = [
    { start: 0, end: redFrac, color: 'rgba(239, 68, 68, 0.5)' },
    { start: redFrac, end: yellowFrac, color: 'rgba(250, 204, 21, 0.5)' },
    { start: yellowFrac, end: 1, color: 'rgba(74, 222, 128, 0.5)' },
  ];
  zones.forEach(z => {
    if (z.start >= z.end) return;
    ctx.beginPath();
    ctx.arc(cx, arcCy, radius, startAngle + z.start * sweepAngle, startAngle + z.end * sweepAngle);
    ctx.strokeStyle = z.color;
    ctx.lineWidth = strokeW;
    ctx.lineCap = 'butt';
    ctx.stroke();
  });

  // Active arc (bright white needle sweep)
  const valueFraction = Math.min(Math.max(agl / maxAgl, 0), 1);
  const needleAngle = startAngle + valueFraction * sweepAngle;
  if (valueFraction > 0) {
    ctx.beginPath();
    ctx.arc(cx, arcCy, radius, startAngle, needleAngle);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = strokeW * 0.5;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Needle dot
    const dotX = cx + radius * Math.cos(needleAngle);
    const dotY = arcCy + radius * Math.sin(needleAngle);
    ctx.beginPath();
    ctx.arc(dotX, dotY, strokeW * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
  }

  // Altitude number
  const numFontSize = size * 0.2;
  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(altDisplay.toString(), cx, cy + size * 0.12);

  // Unit label
  const unitFontSize = size * 0.09;
  ctx.font = '600 ' + unitFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(unitLabel, cx, cy + size * 0.12 + numFontSize * 0.7);

  // Optional label
  if (config.showLabel) {
    const labelFontSize = size * 0.07;
    ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ALT', cx, cy + size * 0.12 - numFontSize * 0.65);
  }

  ctx.restore();
}

function renderAltimeterPreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const size = canvas.height * 0.85;
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = size * 0.38;
  const strokeW = size * 0.06;
  const startAngle = (135 * Math.PI) / 180;
  const sweepAngle = (270 * Math.PI) / 180;

  // Color zones preview
  const zones = [
    { start: 0, end: 0.15, color: 'rgba(239, 68, 68, 0.5)' },
    { start: 0.15, end: 0.3, color: 'rgba(250, 204, 21, 0.5)' },
    { start: 0.3, end: 1, color: 'rgba(74, 222, 128, 0.5)' },
  ];
  zones.forEach(z => {
    ctx.beginPath();
    ctx.arc(cx, cy - size * 0.05, radius, startAngle + z.start * sweepAngle, startAngle + z.end * sweepAngle);
    ctx.strokeStyle = z.color;
    ctx.lineWidth = strokeW;
    ctx.lineCap = 'butt';
    ctx.stroke();
  });

  // Needle at ~80%
  const needleAngle = startAngle + 0.8 * sweepAngle;
  ctx.beginPath();
  ctx.arc(cx, cy - size * 0.05, radius, startAngle, needleAngle);
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = strokeW * 0.5;
  ctx.lineCap = 'round';
  ctx.stroke();

  const numFontSize = size * 0.2;
  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('3200', cx, cy + size * 0.12);

  const unitFontSize = size * 0.09;
  ctx.font = '600 ' + unitFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('M', cx, cy + size * 0.12 + numFontSize * 0.7);
}

function buildAltimeterConfigPanel(widget) {
  const wrap = document.createElement('div');
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: 'Show label' },
    { key: 'showBackground', label: 'Show background' },
    { key: 'fadeIn', label: 'Fade in before exit' },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  wrap.appendChild(checks);
  wrap.appendChild(buildUnitsConfig(widget, [
    { value: 'metric', label: 'Metric' },
    { value: 'imperial', label: 'Imperial' },
  ]));
  return wrap;
}

// ── Speed graph widget ──
function renderSpeedGraphWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const fd = currentFlightData;
  const config = widget.config;
  const effectiveScale = widget.widgetScale || 1;
  const w = contentRect.width * 0.3 * effectiveScale;
  const h = contentRect.height * 0.2 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const x = cx - w / 2;
  const y = cy - h / 2;

  widget._bounds = { x, y, w, h };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h * 0.06);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }

  if (!fd || !fd.times || fd.times.length < 2) {
    ctx.strokeStyle = 'rgba(244, 114, 182, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.8);
    ctx.quadraticCurveTo(x + w * 0.3, y + h * 0.6, x + w * 0.5, y + h * 0.2);
    ctx.quadraticCurveTo(x + w * 0.7, y + h * 0.15, x + w, y + h * 0.25);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const times = fd.times;
  const speeds = fd.vertSpeeds;
  const minT = times[0], maxT = times[times.length - 1];
  const minSpd = Math.min(...speeds), maxSpd = Math.max(...speeds);
  const tRange = maxT - minT || 1;
  const spdRange = maxSpd - minSpd || 1;
  const pad = 4;

  function tx(t) { return x + pad + (t - minT) / tRange * (w - pad * 2); }
  function ty(s) { return y + h - pad - (s - minSpd) / spdRange * (h - pad * 2); }

  // Measuring zone
  if (config.showMeasuringZone && fd.perfWindowStartTime !== null && fd.perfWindowEndTime !== null) {
    const zx1 = tx(fd.perfWindowStartTime);
    const zx2 = tx(fd.perfWindowEndTime);
    ctx.fillStyle = 'rgba(250, 204, 21, 0.12)';
    ctx.fillRect(zx1, y, zx2 - zx1, h);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(zx1, y); ctx.lineTo(zx1, y + h);
    ctx.moveTo(zx2, y); ctx.lineTo(zx2, y + h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Scoring zone
  if (config.showScoringZone && fd.best3sStart !== null && fd.best3sEnd !== null) {
    const sx1 = tx(fd.best3sStart);
    const sx2 = tx(fd.best3sEnd);
    ctx.fillStyle = 'rgba(74, 222, 128, 0.15)';
    ctx.fillRect(sx1, y, sx2 - sx1, h);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx1, y); ctx.lineTo(sx1, y + h);
    ctx.moveTo(sx2, y); ctx.lineTo(sx2, y + h);
    ctx.stroke();
  }

  // Speed line
  ctx.beginPath();
  for (let i = 0; i < times.length; i++) {
    const px = tx(times[i]);
    const py = ty(speeds[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = '#f472b6';
  ctx.lineWidth = 1.5 * effectiveScale;
  ctx.stroke();

  // Fill under line
  ctx.lineTo(tx(times[times.length - 1]), y + h - pad);
  ctx.lineTo(tx(times[0]), y + h - pad);
  ctx.closePath();
  ctx.fillStyle = 'rgba(244, 114, 182, 0.1)';
  ctx.fill();

  // Current position marker
  if (dataIdx >= 0 && dataIdx < times.length) {
    const mx = tx(times[dataIdx]);
    const my = ty(speeds[dataIdx]);
    ctx.beginPath();
    ctx.arc(mx, my, 3 * effectiveScale, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();

    ctx.strokeStyle = 'rgba(248, 250, 252, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx, y);
    ctx.lineTo(mx, y + h);
    ctx.stroke();
  }

  if (config.showLabel) {
    const labelFontSize = h * 0.12;
    ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('SPEED', x + pad, y + h - pad);
  }

  ctx.restore();
}

function renderSpeedGraphPreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width - 16;
  const h = canvas.height - 16;
  const x = 8, y = 8;

  // Fake speed curve (accelerating then plateau)
  ctx.beginPath();
  const pts = [0.9, 0.85, 0.7, 0.45, 0.25, 0.15, 0.12, 0.1, 0.12, 0.35, 0.7];
  for (let i = 0; i < pts.length; i++) {
    const px = x + (i / (pts.length - 1)) * w;
    const py = y + pts[i] * h;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = '#f472b6';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(244, 114, 182, 0.15)';
  ctx.fill();

  ctx.fillStyle = 'rgba(250, 204, 21, 0.15)';
  ctx.fillRect(x + w * 0.25, y, w * 0.45, h);
}

function buildSpeedGraphConfigPanel(widget) {
  const wrap = document.createElement('div');
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: 'Show label' },
    { key: 'showBackground', label: 'Show background' },
    { key: 'showMeasuringZone', label: 'Show measuring zone' },
    { key: 'showScoringZone', label: 'Show scoring zone' },
    { key: 'fadeIn', label: 'Fade in before exit' },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  wrap.appendChild(checks);
  return wrap;
}

// ── Mini map widget ──
function renderMiniMapWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const fd = currentFlightData;
  const config = widget.config;
  const effectiveScale = widget.widgetScale || 1;
  const size = contentRect.height * 0.25 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const x = cx - size / 2;
  const y = cy - size / 2;

  widget._bounds = { x, y, w: size, h: size };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, size, size, size * 0.06);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, size, size);
    }
  }

  if (!fd || !fd.lats || fd.lats.length < 2) {
    // Placeholder: fake curved path
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + size * 0.3, y + size * 0.2);
    ctx.quadraticCurveTo(x + size * 0.7, y + size * 0.3, x + size * 0.6, y + size * 0.6);
    ctx.quadraticCurveTo(x + size * 0.4, y + size * 0.8, x + size * 0.5, y + size * 0.9);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const lats = fd.lats, lons = fd.lons, alts = fd.altitudes;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < lats.length; i++) {
    if (isNaN(lats[i]) || isNaN(lons[i])) continue;
    if (lats[i] < minLat) minLat = lats[i];
    if (lats[i] > maxLat) maxLat = lats[i];
    if (lons[i] < minLon) minLon = lons[i];
    if (lons[i] > maxLon) maxLon = lons[i];
  }

  const latRange = maxLat - minLat || 0.001;
  const cosLat = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const lonRangeAdj = (maxLon - minLon) * cosLat || 0.001;
  const pad = size * 0.1;
  const drawSize = size - pad * 2;

  // Fit aspect ratio
  let scaleX, scaleY, offX = 0, offY = 0;
  if (lonRangeAdj / latRange > 1) {
    scaleX = drawSize / lonRangeAdj;
    scaleY = scaleX;
    offY = (drawSize - latRange * scaleY) / 2;
  } else {
    scaleY = drawSize / latRange;
    scaleX = scaleY;
    offX = (drawSize - lonRangeAdj * scaleX) / 2;
  }

  function px(lat, lon) {
    return {
      x: x + pad + offX + (lon - minLon) * cosLat * scaleX,
      y: y + pad + offY + (maxLat - lat) * scaleY
    };
  }

  const minAlt = Math.min(...alts), maxAlt = Math.max(...alts);
  const altRange = maxAlt - minAlt || 1;

  // Draw path segments color-coded by altitude
  for (let i = 1; i < lats.length; i++) {
    if (isNaN(lats[i]) || isNaN(lons[i]) || isNaN(lats[i - 1]) || isNaN(lons[i - 1])) continue;
    const p0 = px(lats[i - 1], lons[i - 1]);
    const p1 = px(lats[i], lons[i]);
    const altFrac = (alts[i] - minAlt) / altRange;
    // Blue (#38bdf8) at high alt, pink (#f472b6) at low
    const r = Math.round(56 + (244 - 56) * (1 - altFrac));
    const g = Math.round(189 + (114 - 189) * (1 - altFrac));
    const b = Math.round(248 + (182 - 248) * (1 - altFrac));
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = 1.5 * effectiveScale;
    ctx.stroke();
  }

  // Exit marker
  if (config.showExitMarker && fd.exitIdx >= 0 && fd.exitIdx < lats.length) {
    const ep = px(lats[fd.exitIdx], lons[fd.exitIdx]);
    ctx.beginPath();
    ctx.arc(ep.x, ep.y, 3 * effectiveScale, 0, Math.PI * 2);
    ctx.fillStyle = '#facc15';
    ctx.fill();
  }

  // Current position
  if (dataIdx >= 0 && dataIdx < lats.length && !isNaN(lats[dataIdx]) && !isNaN(lons[dataIdx])) {
    const cp = px(lats[dataIdx], lons[dataIdx]);
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 3.5 * effectiveScale, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
  }

  if (config.showLabel) {
    const labelFontSize = size * 0.08;
    ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('MAP', x + pad, y + size - pad);
  }

  ctx.restore();
}

function renderMiniMapPreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = canvas.height * 0.3;

  // Fake spiral path blue→pink
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    const t0 = ((i - 1) / steps) * Math.PI * 3;
    const t1 = (i / steps) * Math.PI * 3;
    const r0 = r * 0.2 + (r * 0.8) * ((i - 1) / steps);
    const r1 = r * 0.2 + (r * 0.8) * (i / steps);
    const frac = i / steps;
    const rc = Math.round(56 + (244 - 56) * frac);
    const gc = Math.round(189 + (114 - 189) * frac);
    const bc = Math.round(248 + (182 - 248) * frac);
    ctx.beginPath();
    ctx.moveTo(cx + r0 * Math.cos(t0), cy + r0 * Math.sin(t0));
    ctx.lineTo(cx + r1 * Math.cos(t1), cy + r1 * Math.sin(t1));
    ctx.strokeStyle = `rgb(${rc},${gc},${bc})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Yellow exit dot
  ctx.beginPath();
  ctx.arc(cx + r * 0.2 * Math.cos(0), cy + r * 0.2 * Math.sin(0), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#facc15';
  ctx.fill();

  // White current dot
  const lastT = Math.PI * 3;
  ctx.beginPath();
  ctx.arc(cx + r * Math.cos(lastT), cy + r * Math.sin(lastT), 3, 0, Math.PI * 2);
  ctx.fillStyle = '#f8fafc';
  ctx.fill();
}

function buildMiniMapConfigPanel(widget) {
  const wrap = document.createElement('div');
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: 'Show label' },
    { key: 'showBackground', label: 'Show background' },
    { key: 'showExitMarker', label: 'Show exit marker' },
    { key: 'fadeIn', label: 'Fade in before exit' },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  wrap.appendChild(checks);
  return wrap;
}

// ── G-Force gauge widget ──
function renderGForceWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const fd = currentFlightData;
  const config = widget.config;
  const effectiveScale = widget.widgetScale || 1;

  let gVal = 1.0, isSample = false;
  if (dataIdx >= 1 && fd && fd.times && dataIdx < fd.times.length) {
    // 3-point moving average of acceleration
    let totalG = 0, count = 0;
    for (let k = Math.max(1, dataIdx - 1); k <= Math.min(fd.times.length - 1, dataIdx + 1); k++) {
      const dt = fd.times[k] - fd.times[k - 1];
      if (dt <= 0) continue;
      const dvN = fd.velNs[k] - fd.velNs[k - 1];
      const dvE = fd.velEs[k] - fd.velEs[k - 1];
      const dvD = fd.vertSpeeds[k] - fd.vertSpeeds[k - 1];
      const accel = Math.sqrt(dvN * dvN + dvE * dvE + dvD * dvD) / dt;
      totalG += accel / 9.81;
      count++;
    }
    gVal = count > 0 ? totalG / count : 1.0;
  } else if (!fd || !fd.times) {
    gVal = 2.5;
    isSample = true;
  }

  const barW = contentRect.height * 0.05 * effectiveScale;
  const barH = contentRect.height * 0.25 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const bx = cx - barW / 2;
  const by = cy - barH / 2;
  const totalW = barW + barW * 2.5; // bar + text area
  widget._bounds = { x: cx - totalW / 2, y: by, w: totalW, h: barH };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    const bgX = cx - totalW / 2 - barW * 0.3;
    const bgW = totalW + barW * 0.6;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(bgX, by - barW * 0.3, bgW, barH + barW * 0.6, barW * 0.3);
      ctx.fill();
    } else {
      ctx.fillRect(bgX, by - barW * 0.3, bgW, barH + barW * 0.6);
    }
  }

  const maxG = 5;

  // Bar background
  ctx.fillStyle = 'rgba(148, 163, 184, 0.15)';
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(bx, by, barW, barH, barW * 0.2);
    ctx.fill();
  } else {
    ctx.fillRect(bx, by, barW, barH);
  }

  // Filled bar from bottom
  const fillFrac = Math.min(gVal / maxG, 1);
  const fillH = barH * fillFrac;
  if (fillH > 0) {
    ctx.save();
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(bx, by, barW, barH, barW * 0.2);
      ctx.clip();
    }
    // Color based on G value
    let barColor;
    if (gVal <= 2) barColor = '#4ade80';
    else if (gVal <= 3) barColor = '#facc15';
    else barColor = '#ef4444';
    ctx.fillStyle = barColor;
    ctx.fillRect(bx, by + barH - fillH, barW, fillH);
    ctx.restore();
  }

  // 1G baseline tick
  const oneGY = by + barH - (barH * (1 / maxG));
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx - 2, oneGY);
  ctx.lineTo(bx + barW + 2, oneGY);
  ctx.stroke();

  // G value text (to right of bar)
  const textX = bx + barW + barW * 0.5;
  const numFontSize = barH * 0.18;
  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(gVal.toFixed(1), textX, cy);

  // "G" label below number
  const labelFontSize = barH * 0.1;
  ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('G', textX, cy + numFontSize * 0.8);

  // Optional label above bar
  if (config.showLabel) {
    const lFontSize = barH * 0.08;
    ctx.font = '600 ' + lFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('G-FORCE', cx, by - barW * 0.15);
  }

  ctx.restore();
}

function renderGForcePreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const barW = canvas.width * 0.15;
  const barH = canvas.height * 0.7;
  const bx = canvas.width * 0.3;
  const by = (canvas.height - barH) / 2;

  // Bar bg
  ctx.fillStyle = 'rgba(148, 163, 184, 0.15)';
  ctx.fillRect(bx, by, barW, barH);

  // Fill at ~50% (2.5G)
  const fillH = barH * 0.5;
  ctx.fillStyle = '#facc15';
  ctx.fillRect(bx, by + barH - fillH, barW, fillH);

  // 1G tick
  const oneGY = by + barH - (barH * 0.2);
  ctx.strokeStyle = 'rgba(248, 250, 252, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(bx - 1, oneGY);
  ctx.lineTo(bx + barW + 1, oneGY);
  ctx.stroke();

  // Text
  const numFontSize = barH * 0.2;
  ctx.font = 'bold ' + numFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('2.5', bx + barW + 4, canvas.height / 2);

  const labelFontSize = barH * 0.12;
  ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('G', bx + barW + 4, canvas.height / 2 + numFontSize * 0.8);
}

function buildGForceConfigPanel(widget) {
  const wrap = document.createElement('div');
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: 'Show label' },
    { key: 'showBackground', label: 'Show background' },
    { key: 'fadeIn', label: 'Fade in before exit' },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  wrap.appendChild(checks);
  return wrap;
}

// ── Per-widget fade-in opacity ──
function getWidgetOpacity(widget, dataIdx) {
  if (!widget.config.fadeIn) return 1;
  if (videoExitTime === null || !currentFlightData) return 1;
  if (dataIdx < 0 || dataIdx >= currentFlightData.times.length) return 1;
  const t = currentFlightData.times[dataIdx];
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

  // Corner handles
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

  // Delete button (top-right, outside the box)
  const delSize = 16;
  const delX = b.x + b.w + 4;
  const delY = b.y - delSize - 4;
  widget._deleteBtn = { x: delX, y: delY, size: delSize };

  // Circle background
  ctx.beginPath();
  ctx.arc(delX + delSize / 2, delY + delSize / 2, delSize / 2 + 2, 0, Math.PI * 2);
  ctx.fillStyle = '#ef4444';
  ctx.fill();

  // X icon
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
  for (let i = widgets.length - 1; i >= 0; i--) {
    const w = widgets[i];
    if (!w._bounds) continue;
    const b = w._bounds;
    const handleSize = 10; // generous hit area

    // Check delete button (only on selected widget)
    if (w.id === selectedWidgetId && w._deleteBtn) {
      const d = w._deleteBtn;
      const dcx = d.x + d.size / 2;
      const dcy = d.y + d.size / 2;
      if (Math.sqrt((canvasX - dcx) ** 2 + (canvasY - dcy) ** 2) < d.size / 2 + 4) {
        return { widget: w, handle: 'delete' };
      }
    }

    // Check corner handles first
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

    // Check body
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

  if (selectedWidgetId === null) {
    row.style.display = 'none';
    return;
  }

  const widget = widgets.find(w => w.id === selectedWidgetId);
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


// Export pipeline
async function startExport() {
  if (videoExitTime === null) { alert('Please mark the exit moment first.'); return; }
  if (!currentFlightData) { alert('No flight data loaded.'); return; }
  if (widgets.length === 0) { alert('No widgets placed on the overlay.'); return; }

  const video = document.getElementById('videoPreview');

  // Compute trim bounds
  const trimStart = Math.max(0, videoExitTime - 5);
  const canopyFlightTime = currentFlightData.times[currentFlightData.canopyIdx] || currentFlightData.times[currentFlightData.times.length - 1];
  const trimEnd = Math.min(video.duration, videoExitTime + canopyFlightTime);

  // Set up canvas
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  // Detect best format
  let mimeType = 'video/webm;codecs=vp9';
  let fileExt = '.webm';
  if (MediaRecorder.isTypeSupported('video/mp4')) {
    mimeType = 'video/mp4';
    fileExt = '.mp4';
  } else if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm';
  }

  // Set up MediaRecorder
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentJumpName.replace(/\.[^.]+$/, '') + '_overlay' + fileExt;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.getElementById('exportProgress').style.display = 'none';
    document.getElementById('exportBtn').disabled = false;
    document.getElementById('videoPlayBtn').textContent = 'Play';
  };

  // Show progress
  document.getElementById('exportProgress').style.display = 'block';
  document.getElementById('exportBtn').disabled = true;
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressText').textContent = 'Preparing...';

  // Seek to trim start
  video.currentTime = trimStart;
  video.muted = true;
  await new Promise(r => video.addEventListener('seeked', r, { once: true }));

  recorder.start();
  video.play();

  const contentRect = { width: canvas.width, height: canvas.height };

  function renderFrame() {
    if (video.currentTime >= trimEnd || video.paused || video.ended) {
      video.pause();
      recorder.stop();
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataIdx = videoTimeToDataIndex(video.currentTime);

    // Render all widgets with per-widget fade-in
    for (const widget of widgets) {
      const typeDef = WIDGET_TYPES[widget.type];
      if (!typeDef) continue;
      const opacity = getWidgetOpacity(widget, dataIdx);
      typeDef.render(ctx, contentRect, widget, dataIdx, null, null, opacity);
    }

    const pct = ((video.currentTime - trimStart) / (trimEnd - trimStart)) * 100;
    document.getElementById('progressFill').style.width = Math.min(pct, 100) + '%';
    document.getElementById('progressText').textContent = 'Exporting... ' + Math.round(pct) + '%';

    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(renderFrame);
    } else {
      requestAnimationFrame(renderFrame);
    }
  }

  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback(renderFrame);
  } else {
    requestAnimationFrame(renderFrame);
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

  // Render all widgets with per-widget fade-in
  for (const widget of widgets) {
    const typeDef = WIDGET_TYPES[widget.type];
    if (!typeDef) continue;
    const opacity = getWidgetOpacity(widget, dataIdx);
    typeDef.render(ctx, contentRect, widget, dataIdx, null, null, opacity);
  }

  // Draw selection handles for selected widget
  if (selectedWidgetId !== null) {
    const sw = widgets.find(w => w.id === selectedWidgetId);
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

// ── Canvas interaction: drag-from-picker & widget move/resize ──
(function() {
  const canvas = document.getElementById('overlayPreviewCanvas');

  // Drag from picker to canvas
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
      selectedWidgetId = w.id;
      updateWidgetSettingsPanel();
      drawOverlayPreview();
    }
  });

  // Mouse interactions on canvas for select/move/resize
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

      selectedWidgetId = hit.widget.id;
      updateWidgetSettingsPanel();

      if (hit.handle) {
        widgetDragState = {
          mode: 'resize', widgetId: hit.widget.id,
          startX: mx, startY: my,
          origX: hit.widget.x, origY: hit.widget.y,
          origW: hit.widget._bounds ? hit.widget._bounds.w : 0,
          origH: hit.widget._bounds ? hit.widget._bounds.h : 0,
          origScale: hit.widget.widgetScale || 1,
          handle: hit.handle, contentW: rect.contentW, contentH: rect.contentH,
        };
      } else {
        widgetDragState = {
          mode: 'move', widgetId: hit.widget.id,
          startX: mx, startY: my,
          origX: hit.widget.x, origY: hit.widget.y,
          contentW: rect.contentW, contentH: rect.contentH,
        };
      }
      drawOverlayPreview();
    } else {
      selectedWidgetId = null;
      updateWidgetSettingsPanel();
      drawOverlayPreview();
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (!widgetDragState) {
      // Update cursor based on hit
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
    const ds = widgetDragState;
    const widget = widgets.find(w => w.id === ds.widgetId);
    if (!widget) return;

    if (ds.mode === 'move') {
      const dx = (mx - ds.startX) / ds.contentW;
      const dy = (my - ds.startY) / ds.contentH;
      widget.x = Math.max(0.05, Math.min(0.95, ds.origX + dx));
      widget.y = Math.max(0.05, Math.min(0.95, ds.origY + dy));
      drawOverlayPreview();
    } else if (ds.mode === 'resize') {
      // Scale widget based on how far the corner handle moved from its original position
      const origDiag = Math.sqrt(ds.origW * ds.origW + ds.origH * ds.origH);
      if (origDiag > 0) {
        // Compute distance from widget center to mouse
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
    widgetDragState = null;
  });

  canvas.addEventListener('mouseleave', () => {
    widgetDragState = null;
    canvas.style.cursor = 'default';
  });

  // Delete key removes selected widget
  document.addEventListener('keydown', e => {
    if (e.key === 'Delete' && selectedWidgetId !== null) {
      // Don't delete if user is typing in an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      removeWidget(selectedWidgetId);
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

    // Click to place at default position
    card.addEventListener('click', () => {
      const type = card.getAttribute('data-widget-type');
      if (!WIDGET_TYPES[type]) return;
      // Default positions per widget type
      const defaultPositions = {
        info: { x: 0.85, y: 0.15 },
        altimeter: { x: 0.15, y: 0.15 },
        miniMap: { x: 0.85, y: 0.85 },
        gForce: { x: 0.15, y: 0.5 },
      };
      const defaultPos = defaultPositions[type] || { x: 0.15, y: 0.85 };
      const w = createWidget(type, defaultPos.x, defaultPos.y);
      if (w) {
        selectedWidgetId = w.id;
        updateWidgetSettingsPanel();
        drawOverlayPreview();
      }
    });
  });
})();

// Wire up preview updates
window.addEventListener('resize', drawOverlayPreview);

// Draw preview when video loads
document.getElementById('videoPreview').addEventListener('loadeddata', function() {
  drawOverlayPreview();
});

// Render widget card previews on load
renderWidgetPreviews();

// ── Init ──
renderJumpList();
const jumps = getStoredJumps();
if (jumps.length > 0) selectJump(jumps[jumps.length - 1].name);
