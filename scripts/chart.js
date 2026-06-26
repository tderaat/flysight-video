
// ── Manual exit-point overrides ──
// Persisted per jump in localStorage as the exit time in *recording-relative*
// seconds (robust against re-parsing since the CSV for a given name is
// immutable). Kept synchronous/tiny, mirroring flysight_scores.
function getExitOverrides() {
  try { return JSON.parse(localStorage.getItem('flysight_exit_overrides') || '{}'); }
  catch (e) { return {}; }
}

function getExitOverride(name) {
  const v = getExitOverrides()[name];
  return Number.isFinite(v) ? v : null;
}

function setExitOverride(name, recordingTimeSec) {
  const o = getExitOverrides();
  o[name] = recordingTimeSec;
  try { localStorage.setItem('flysight_exit_overrides', JSON.stringify(o)); } catch (e) { /* ignore */ }
}

function clearExitOverride(name) {
  const o = getExitOverrides();
  delete o[name];
  try { localStorage.setItem('flysight_exit_overrides', JSON.stringify(o)); } catch (e) { /* ignore */ }
}

// ── Chart series on/off persistence ──
// Which datasets the user has toggled via the chart legend, persisted globally
// (not per-jump) as a map of dataset label -> visible boolean. Tiny + synchronous,
// mirroring flysight_scores / flysight_exit_overrides.
function getChartSeriesVisibility() {
  try { return JSON.parse(localStorage.getItem('flysight_chart_series') || '{}'); }
  catch (e) { return {}; }
}

function saveChartSeriesVisibility(chart) {
  const map = {};
  // Keyed by the language-independent seriesKey (not the translated label) so
  // the stored choice survives a language switch. Falls back to label for any
  // dataset without a seriesKey.
  chart.data.datasets.forEach((d, i) => { map[d.seriesKey || d.label] = chart.isDatasetVisible(i); });
  try { localStorage.setItem('flysight_chart_series', JSON.stringify(map)); } catch (e) { /* ignore */ }
}

// Format a FlySight ISO 8601 timestamp (e.g. "2025-09-14T12:15:08.10Z") into
// separate UTC date ("2025-09-14") and time ("12:15:08 UTC") parts. Falls back
// to the raw string (as the date, empty time) if it can't be parsed.
function formatUtcTimestamp(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { date: iso || '—', time: '' };
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  };
}

// Convert a FlySight ISO 8601 timestamp to Amsterdam local time, DST-aware via
// Intl (Europe/Amsterdam → CET/CEST). Returns "2025-09-14 14:15:08 CEST", or
// '' if the timestamp can't be parsed.
function formatAmsterdamTimestamp(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZoneName: 'short'
    }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
  } catch (e) {
    return '';
  }
}

function zoomChart(direction) {
  if (!state.chartInstance) return;
  state.chartInstance.zoom(direction > 0 ? 1.2 : 1 / 1.2);
  // chartjs-plugin-zoom does not fire onZoomComplete for programmatic calls,
  // so trigger the map re-render explicitly here.
  syncMapToChart();
}

function syncMapToChart() {
  if (!state.chartInstance || !state.lastRenderMap) return;
  const sx = state.chartInstance.scales.x;
  state.lastRenderMap(sx.min, sx.max);
}

function setChartActiveAtIndex(idx) {
  if (!state.chartInstance) return;
  const c = state.chartInstance;
  const active = c.data.datasets.map((_, di) => ({ datasetIndex: di, index: idx }));
  c.setActiveElements(active);
  if (c.tooltip) {
    c.tooltip.setActiveElements(active, { x: 0, y: 0 });
  }
  c.update('none');
  c.draw();
}

function clearChartActive() {
  if (!state.chartInstance) return;
  const c = state.chartInstance;
  c.setActiveElements([]);
  if (c.tooltip) {
    c.tooltip.setActiveElements([], { x: 0, y: 0 });
  }
  c.update('none');
  c.draw();
}

async function renderCurrentJump(showFull) {
  const jumps = await getStoredJumps();
  const jump = jumps.find(j => j.name === state.currentJumpName);
  if (!jump) return;

  const section = document.getElementById('chartSection');
  section.style.display = 'block';

  const data = parseFlySightCSV(jump.csv);
  if (data.length < 50) { section.innerHTML = '<p>' + t('chart.notEnoughData') + '</p>'; return; }

  const firstT = parseTimestamp(data[0].time);
  const allTimes = data.map(r => (parseTimestamp(r.time) - firstT) / 1000);
  const allAlts = data.map(r => parseFloat(r.hMSL));
  const allVelD = data.map(r => parseFloat(r.velD));

  let startIdx = 0, endIdx = data.length - 1;

  // Apply a manual exit override (set via the chart's right-click menu), snapped
  // to the nearest sample. Falls back to automatic detection when none is set.
  const exitOverrideSec = getExitOverride(state.currentJumpName);
  let forcedExitIdx;
  if (exitOverrideSec !== null) {
    let best = 0, bestDiff = Infinity;
    for (let i = 0; i < allTimes.length; i++) {
      const d = Math.abs(allTimes[i] - exitOverrideSec);
      if (d < bestDiff) { bestDiff = d; best = i; }
    }
    forcedExitIdx = best;
  }

  const { exitIdx, landingIdx, canopyIdx } = detectExitAndLanding(data, forcedExitIdx);
  const exitTime = allTimes[exitIdx];
  const canopyTimeRel = allTimes[canopyIdx] - exitTime;

  // Context the chart's right-click "Set exit" handler needs to convert a
  // clicked x-value (time relative to the current exit) back into an absolute
  // recording-relative time, plus current view mode for re-render.
  state.exitEditCtx = { allTimes, exitTimeRel: exitTime, hasOverride: exitOverrideSec !== null };
  state.chartShowFull = !!showFull;

  if (!showFull) {
    const beforeSec = 5;
    const afterSec = 5;
    const canopyTime = allTimes[canopyIdx];

    startIdx = allTimes.findIndex(t => t >= exitTime - beforeSec);
    endIdx = allTimes.findIndex(t => t >= canopyTime + afterSec);
    if (startIdx < 0) startIdx = 0;
    if (endIdx < 0) endIdx = data.length - 1;
  }

  const times = [], altitudes = [], vertSpeeds = [], horzSpeeds = [], diveAngles = [], sliceLats = [], sliceLons = [], velNs = [], velEs = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const tRel = allTimes[i] - exitTime;
    times.push(tRel);
    altitudes.push(allAlts[i]);
    vertSpeeds.push(allVelD[i]);
    const vN = parseFloat(data[i].velN) || 0;
    const vE = parseFloat(data[i].velE) || 0;
    const hSpd = Math.sqrt(vN * vN + vE * vE);
    horzSpeeds.push(hSpd);
    if (tRel < -5 || tRel > canopyTimeRel + 5) {
      diveAngles.push(null);
    } else {
      diveAngles.push(Math.atan2(allVelD[i], hSpd) * (180 / Math.PI));
    }
    velNs.push(vN);
    velEs.push(vE);
    sliceLats.push(parseFloat(data[i].lat));
    sliceLons.push(parseFloat(data[i].lon));
  }

  // Full-data arrays — fed to chart datasets and to map (window-filtered).
  // Independent of the slice arrays above, which still drive state.currentFlightData
  // (the contract video overlay widgets depend on).
  const chartTimes = [], chartAlts = [], chartVertSpeeds = [], chartHorzSpeeds = [], chartDiveAngles = [], chartLats = [], chartLons = [], chartVelNs = [], chartVelEs = [];
  for (let i = 0; i < data.length; i++) {
    const tRel = allTimes[i] - exitTime;
    chartTimes.push(tRel);
    chartAlts.push(allAlts[i]);
    chartVertSpeeds.push(allVelD[i]);
    const vN = parseFloat(data[i].velN) || 0;
    const vE = parseFloat(data[i].velE) || 0;
    const hSpd = Math.sqrt(vN * vN + vE * vE);
    chartHorzSpeeds.push(hSpd);
    if (tRel < -5 || tRel > canopyTimeRel + 5) {
      chartDiveAngles.push(null);
    } else {
      chartDiveAngles.push(Math.atan2(allVelD[i], hSpd) * (180 / Math.PI));
    }
    chartLats.push(parseFloat(data[i].lat));
    chartLons.push(parseFloat(data[i].lon));
    chartVelNs.push(vN);
    chartVelEs.push(vE);
  }

  // Optional extra series (off by default, toggled via the chart legend):
  //  - Downward acceleration (m/s²): central-difference derivative of velD.
  //    Positive = speeding up downward; negative = decelerating (e.g. canopy opening).
  //  - Satellite count (numSV): GPS fix quality indicator.
  const chartAccelDown = [], chartNumSV = [];
  for (let i = 0; i < data.length; i++) {
    let a;
    if (i === 0) {
      a = (allVelD[1] - allVelD[0]) / (allTimes[1] - allTimes[0]);
    } else if (i === data.length - 1) {
      a = (allVelD[i] - allVelD[i - 1]) / (allTimes[i] - allTimes[i - 1]);
    } else {
      a = (allVelD[i + 1] - allVelD[i - 1]) / (allTimes[i + 1] - allTimes[i - 1]);
    }
    chartAccelDown.push(isFinite(a) ? a : null);
    const nsv = parseInt(data[i].numSV, 10);
    chartNumSV.push(isNaN(nsv) ? null : nsv);
  }
  // Headroom above the satellite max so the line doesn't sit flush on the top edge.
  const satValues = chartNumSV.filter(v => v != null && isFinite(v));
  const maxSat = satValues.length ? Math.max.apply(null, satValues) : 0;

  // G-force per sample (shown in the tooltip). Magnitude of the GPS-velocity
  // change vector over time, in g — same formula and 3-point smoothing as the
  // G-Force overlay widget, so the tooltip and gauge agree. null at the first
  // sample (no preceding point to difference against).
  const chartGForce = [];
  for (let i = 0; i < data.length; i++) {
    let gv = null;
    if (i >= 1) {
      let total = 0, count = 0;
      for (let k = Math.max(1, i - 1); k <= Math.min(data.length - 1, i + 1); k++) {
        const dt = allTimes[k] - allTimes[k - 1];
        if (dt <= 0) continue;
        const dvN = chartVelNs[k] - chartVelNs[k - 1];
        const dvE = chartVelEs[k] - chartVelEs[k - 1];
        const dvD = chartVertSpeeds[k] - chartVertSpeeds[k - 1];
        const accel = Math.sqrt(dvN * dvN + dvE * dvE + dvD * dvD) / dt;
        total += accel / 9.81;
        count++;
      }
      gv = count > 0 ? total / count : null;
    }
    chartGForce.push(gv);
  }

  // Full-recording y-axis bounds — locks altitude and speed scales to the
  // entire jump (airplane climb + freefall + canopy + landing) so they don't
  // rescale when the user pans/zooms across the chart.
  const chartVertSpeedsKmh = chartVertSpeeds.map(v => v * 3.6);
  const chartHorzSpeedsKmh = chartHorzSpeeds.map(v => v * 3.6);
  const yAltMin = Math.min.apply(null, chartAlts);
  const yAltMax = Math.max.apply(null, chartAlts);
  // Add 20 km/h of headroom so the fastest speed doesn't touch the top of the chart.
  const ySpeedMax = Math.max(Math.max.apply(null, chartVertSpeedsKmh), Math.max.apply(null, chartHorzSpeedsKmh)) + 20;
  const ySpeedMin = Math.min(0, Math.min.apply(null, chartVertSpeedsKmh), Math.min.apply(null, chartHorzSpeedsKmh));

  const exitAlt = allAlts[exitIdx];
  const groundAlt = allAlts[landingIdx];
  const maxFallSpeed = Math.max(...vertSpeeds);
  const maxSpeedKmh = (maxFallSpeed * 3.6).toFixed(0);

  // ── FAI Speed Skydiving Performance Window ──
  const PERF_WINDOW_HEIGHT = 7400 * 0.3048;
  const BREAKOFF_AGL = 5600 * 0.3048;
  const breakoffAltMSL = groundAlt + BREAKOFF_AGL;

  const VELD_THRESHOLD = 10;
  let perfWindowStartTime = null;
  let perfWindowStartAlt = null;
  for (let i = 1; i < times.length; i++) {
    if (times[i] < 0) continue;
    if (vertSpeeds[i] >= VELD_THRESHOLD) {
      if (times[i - 1] >= 0 && vertSpeeds[i - 1] < VELD_THRESHOLD) {
        const frac = (VELD_THRESHOLD - vertSpeeds[i - 1]) / (vertSpeeds[i] - vertSpeeds[i - 1]);
        perfWindowStartTime = times[i - 1] + frac * (times[i] - times[i - 1]);
        perfWindowStartAlt = altitudes[i - 1] + frac * (altitudes[i] - altitudes[i - 1]);
      } else {
        perfWindowStartTime = times[i];
        perfWindowStartAlt = altitudes[i];
      }
      break;
    }
  }

  const windowEndByDrop = perfWindowStartAlt !== null ? perfWindowStartAlt - PERF_WINDOW_HEIGHT : null;
  const perfWindowEndAlt = windowEndByDrop !== null ? Math.max(windowEndByDrop, breakoffAltMSL) : breakoffAltMSL;

  let perfWindowEndTime = null;
  for (let i = 0; i < times.length; i++) {
    if (times[i] >= 0 && altitudes[i] <= perfWindowEndAlt) {
      perfWindowEndTime = times[i];
      break;
    }
  }

  // Speed score computation
  const TIME_DELTA = 0.005;
  const SCORE_WINDOW = 3;
  const windowBottomAGL = BREAKOFF_AGL;
  const fromExit = PERF_WINDOW_HEIGHT;
  let speedScore = null;
  let best3sStart = null;
  let best3sEnd = null;
  if (perfWindowStartTime !== null && perfWindowEndTime !== null) {
    const altsAGL = altitudes.map(a => a - groundAlt);
    const perfStartAltAGL = perfWindowStartAlt - groundAlt;

    let maxScore = 0;
    let iStart = times.length - 1;

    for (let iEnd = times.length - 1; iEnd >= 0; iEnd--) {
      const tStart = times[iEnd] - SCORE_WINDOW;

      while (iStart >= 0 && times[iStart] > tStart + TIME_DELTA) {
        iStart--;
      }

      if (iStart < 0) break;
      if (times[iStart] < 0) break;

      if (altsAGL[iEnd] < perfStartAltAGL - fromExit) continue;
      if (altsAGL[iEnd] < windowBottomAGL) continue;

      if (times[iStart] < tStart - TIME_DELTA) continue;

      const score = (altsAGL[iStart] - altsAGL[iEnd]) / (times[iEnd] - times[iStart]);
      if (score > maxScore) {
        maxScore = score;
        best3sStart = times[iStart];
        best3sEnd = times[iEnd];
      }
    }
    if (maxScore > 0) speedScore = maxScore * 3.6;
  }

  // Cache speed score
  try {
    const scores = JSON.parse(localStorage.getItem('flysight_scores') || '{}');
    scores[state.currentJumpName] = speedScore;
    localStorage.setItem('flysight_scores', JSON.stringify(scores));
  } catch (e) { /* ignore */ }
  renderJumpList();

  const dateStr = data[0].time ? data[0].time.split('T')[0] : '';
  document.getElementById('chartTitle').textContent = dateStr + ' — ' + state.currentJumpName;

  // ── Exit altitude validation ──
  const exitAltAGL = exitAlt - groundAlt;
  const EXIT_MIN_AGL = 3962;
  const EXIT_MAX_AGL = 4267;
  const exitValid = exitAltAGL >= EXIT_MIN_AGL && exitAltAGL <= EXIT_MAX_AGL;
  const exitTooHigh = exitAltAGL > EXIT_MAX_AGL;

  let exitBadgeClass, exitBadgeIcon, exitTooltip;
  if (exitValid) {
    exitBadgeClass = 'badge-valid';
    exitBadgeIcon = '&#10003;';
    exitTooltip = t('exit.valid', { max: EXIT_MAX_AGL });
  } else if (exitTooHigh) {
    exitBadgeClass = 'badge-invalid';
    exitBadgeIcon = '&#9888;';
    exitTooltip = t('exit.tooHigh', { max: EXIT_MAX_AGL });
  } else {
    exitBadgeClass = 'badge-invalid';
    exitBadgeIcon = '&#9888;';
    exitTooltip = t('exit.tooLow', { min: EXIT_MIN_AGL });
  }

  const speedScoreHtml = speedScore !== null
    ? `<div class="stat-card">
        <div class="stat-label">${t('stat.speedScore3s')}</div>
        <div class="stat-value alt">${speedScore.toFixed(2)} km/h</div>
      </div>`
    : '';

  const utcStart = formatUtcTimestamp(data[0].time);
  const amsStart = formatAmsterdamTimestamp(data[0].time);

  document.getElementById('stats').innerHTML = `
    ${speedScoreHtml}
    <div class="stat-card">
      <div class="stat-label">${t('stat.maxVertSpeed')}</div>
      <div class="stat-value alt">${maxSpeedKmh} km/h / ${(maxFallSpeed * 2.23694).toFixed(0)} mph</div>
    </div>
    <div class="stat-card">
      <span class="exit-badge ${exitBadgeClass}">
        <span class="exit-badge-icon">${exitBadgeIcon}</span>
        <span class="exit-tooltip">${exitTooltip.replace('\n', '<br>')}</span>
      </span>
      <div class="stat-label">${t('stat.exitAltitude')}</div>
      <div class="stat-value alt">${exitAlt.toFixed(0)} m / ${(exitAlt * 3.28084).toFixed(0)} ft</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">${t('stat.speedWindow')}</div>
      <div class="stat-detail alt"><span class="stat-detail-label">${t('stat.start')}</span> ${perfWindowStartAlt !== null ? perfWindowStartAlt.toFixed(0) + ' m / ' + (perfWindowStartAlt * 3.28084).toFixed(0) + ' ft' : '—'}</div>
      <div class="stat-detail alt"><span class="stat-detail-label">${t('stat.end')}</span> ${perfWindowEndAlt.toFixed(0)} m / ${(perfWindowEndAlt * 3.28084).toFixed(0)} ft</div>
    </div>
    <div class="stat-card"${amsStart ? ` data-tip="${t('stat.amsterdamTip', { time: amsStart })}"` : ''}>
      <div class="stat-label">${t('stat.utcStart')}</div>
      <div class="stat-detail alt">${utcStart.date}</div>
      <div class="stat-detail alt">${utcStart.time}</div>
    </div>
  `;

  // ── Theme-aware colors (read fresh each render so theme switches take effect) ──
  const themeAccent     = getThemeColor('accent')      || '#38bdf8';
  const themeAccentFill = getThemeColor('accent-fill') || hexToRgba(themeAccent, 0.08);
  const themeBgCard     = getThemeColor('bg-card')     || '#1e293b';
  const themeBorder     = getThemeColor('border')      || '#334155';
  const themeText       = getThemeColor('text-mid')    || '#cbd5e1';
  const themeTextStrong = getThemeColor('text-strong') || '#f8fafc';
  const themeTextMuted  = getThemeColor('text-muted')  || '#94a3b8';
  const themeTextDim    = getThemeColor('text-dim')    || '#64748b';

  // ── Chart ──
  if (state.chartInstance) state.chartInstance.destroy();

  const ctx = document.getElementById('chart').getContext('2d');
  state.chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartTimes,
      datasets: [
        {
          label: t('chart.altitude'),
          seriesKey: 'altitude',
          data: chartAlts,
          borderColor: themeAccent,
          backgroundColor: themeAccentFill,
          fill: true,
          yAxisID: 'yAlt',
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.2,
          order: 2
        },
        {
          label: t('chart.vertSpeed'),
          seriesKey: 'vertSpeed',
          data: chartVertSpeeds.map(v => v * 3.6),
          borderColor: '#4ade80',
          backgroundColor: 'rgba(74,222,128,0.08)',
          fill: false,
          yAxisID: 'ySpeed',
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.2,
          order: 1
        },
        {
          label: t('chart.groundSpeed'),
          seriesKey: 'groundSpeed',
          data: chartHorzSpeeds.map(v => v * 3.6),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.08)',
          fill: false,
          yAxisID: 'ySpeed',
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.2,
          order: 0
        },
        {
          label: t('chart.diveAngle'),
          seriesKey: 'diveAngle',
          data: chartDiveAngles,
          borderColor: '#f472b6',
          backgroundColor: 'rgba(244,114,182,0.08)',
          fill: false,
          yAxisID: 'yAngle',
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.2,
          order: 0
        },
        {
          label: t('chart.accelDown'),
          seriesKey: 'accelDown',
          data: chartAccelDown,
          borderColor: '#fb923c',
          backgroundColor: 'rgba(251,146,60,0.08)',
          fill: false,
          yAxisID: 'yAccel',
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.2,
          hidden: true,
          order: 0
        },
        {
          label: t('chart.satellites'),
          seriesKey: 'satellites',
          data: chartNumSV,
          borderColor: '#a78bfa',
          backgroundColor: 'rgba(167,139,250,0.08)',
          fill: false,
          yAxisID: 'ySat',
          pointRadius: 0,
          borderWidth: 1.5,
          stepped: true,
          tension: 0,
          hidden: true,
          order: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onHover: function(event, elements) {
        if (elements.length > 0 && state.mapInstance) {
          const idx = elements[0].index;
          const lat = chartLats[idx];
          const lon = chartLons[idx];
          if (!isNaN(lat) && !isNaN(lon)) {
            if (!state.hoverMarker) {
              state.hoverMarker = L.circleMarker([lat, lon], {
                radius: 7, fillColor: '#fff', color: '#0f172a', weight: 2, fillOpacity: 1
              }).addTo(state.mapInstance);
            } else {
              state.hoverMarker.setLatLng([lat, lon]);
            }
          }
        }
      },
      plugins: {
        zoom: {
          pan: { enabled: true, mode: 'x', onPanComplete: syncMapToChart },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'x',
            onZoomComplete: syncMapToChart
          },
          limits: {
            x: { min: chartTimes[0], max: chartTimes[chartTimes.length - 1] }
          }
        },
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
                content: t('annot.exit'),
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
                  content: t('annot.windowEnd'),
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
                  content: t('annot.best3s'),
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
          labels: { color: themeText, font: { size: 13 }, usePointStyle: true, pointStyle: 'line' },
          onClick: function(e, legendItem, legend) {
            Chart.defaults.plugins.legend.onClick(e, legendItem, legend);
            saveChartSeriesVisibility(legend.chart);
          }
        },
        tooltip: {
          animation: false,
          backgroundColor: themeBgCard,
          titleColor: themeTextStrong,
          bodyColor: themeText,
          borderColor: themeBorder,
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
              const di = ctx.datasetIndex;
              if (di === 0) {
                const m = ctx.parsed.y;
                return ' ' + t('tt.altitude') + ': ' + m.toFixed(0) + ' m (' + (m * 3.28084).toFixed(0) + ' ft)';
              } else if (di === 1) {
                return ' ' + t('tt.vertSpeed') + ': ' + ctx.parsed.y.toFixed(0) + ' km/h';
              } else if (di === 2) {
                return ' ' + t('tt.groundSpeed') + ': ' + ctx.parsed.y.toFixed(0) + ' km/h';
              } else if (di === 3) {
                if (ctx.parsed.y == null || isNaN(ctx.parsed.y)) return null;
                return ' ' + t('tt.diveAngle') + ': ' + ctx.parsed.y.toFixed(1) + '°';
              } else if (di === 4) {
                if (ctx.parsed.y == null || isNaN(ctx.parsed.y)) return null;
                return ' ' + t('tt.accelDown') + ': ' + ctx.parsed.y.toFixed(1) + ' m/s²';
              } else {
                if (ctx.parsed.y == null || isNaN(ctx.parsed.y)) return null;
                return ' ' + t('tt.satellites') + ': ' + ctx.parsed.y;
              }
            },
            afterBody: function(items) {
              if (!items.length) return [];
              const gv = chartGForce[items[0].dataIndex];
              if (gv == null || !isFinite(gv)) return [];
              return [' ' + t('tt.gForce') + ': ' + gv.toFixed(2) + ' G'];
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: showFull ? undefined : -5,
          max: showFull ? undefined : (canopyTimeRel + 5),
          title: { display: true, text: t('axis.time'), color: themeTextMuted },
          ticks: {
            color: themeTextDim,
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
          min: yAltMin,
          max: yAltMax,
          title: { display: true, text: t('axis.altitude'), color: themeAccent },
          ticks: { color: themeAccent },
          grid: { color: themeAccentFill }
        },
        ySpeed: {
          type: 'linear',
          position: 'right',
          min: ySpeedMin,
          max: ySpeedMax,
          title: { display: true, text: t('axis.speed'), color: '#4ade80' },
          ticks: { color: '#4ade80' },
          grid: { drawOnChartArea: false }
        },
        yAngle: {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 90,
          title: { display: true, text: t('axis.diveAngle'), color: '#f472b6' },
          ticks: { color: '#f472b6' },
          grid: { drawOnChartArea: false }
        },
        yAccel: {
          type: 'linear',
          position: 'right',
          display: 'auto',
          title: { display: true, text: t('axis.accelDown'), color: '#fb923c' },
          ticks: { color: '#fb923c' },
          grid: { drawOnChartArea: false }
        },
        ySat: {
          type: 'linear',
          position: 'right',
          display: 'auto',
          min: 0,
          max: maxSat + 2,
          title: { display: true, text: t('axis.satellites'), color: '#a78bfa' },
          ticks: { color: '#a78bfa', precision: 0, stepSize: 1 },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });

  // Restore the user's last on/off choices for each series (global preference).
  const savedVis = getChartSeriesVisibility();
  state.chartInstance.data.datasets.forEach((d, i) => {
    const key = d.seriesKey || d.label;
    if (Object.prototype.hasOwnProperty.call(savedVis, key)) {
      state.chartInstance.setDatasetVisibility(i, savedVis[key]);
    }
  });
  state.chartInstance.update('none');

  // ── Map: re-rendered any time the chart's visible time window changes ──
  function renderMap(tMin, tMax) {
    // Window-filtered arrays (subset of full data within [tMin, tMax])
    const windowLats = [], windowLons = [], windowTimes = [], windowAlts = [], windowVertSpeeds = [], windowHorzSpeeds = [], windowFullIdx = [];
    for (let i = 0; i < chartTimes.length; i++) {
      const t = chartTimes[i];
      if (t < tMin || t > tMax) continue;
      windowLats.push(chartLats[i]);
      windowLons.push(chartLons[i]);
      windowTimes.push(t);
      windowAlts.push(chartAlts[i]);
      windowVertSpeeds.push(chartVertSpeeds[i]);
      windowHorzSpeeds.push(chartHorzSpeeds[i]);
      windowFullIdx.push(i);
    }

    const pathCoords = [];
    const pathTimes = [];
    for (let i = 0; i < windowLats.length; i++) {
      if (!isNaN(windowLats[i]) && !isNaN(windowLons[i])) {
        pathCoords.push([windowLats[i], windowLons[i]]);
        pathTimes.push(windowTimes[i]);
      }
    }

    if (state.mapInstance) { state.mapInstance.remove(); state.mapInstance = null; }
    state.hoverMarker = null;
    state.mapHoverTooltip = null;

    state.mapInstance = L.map('map', { attributionControl: true });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri, Maxar, Earthstar Geographics',
      maxZoom: 19
    }).addTo(state.mapInstance);

    // Color-coded polyline using time-based phase boundaries. Pre-exit
    // segments use the active theme accent so the airplane track matches
    // the altitude line on the chart.
    for (let i = 0; i < pathCoords.length - 1; i++) {
      let color;
      if (pathTimes[i] < 0) color = themeAccent;
      else if (pathTimes[i] < canopyTimeRel) color = '#ef4444';
      else color = '#1e1e1e';
      L.polyline([pathCoords[i], pathCoords[i + 1]], {
        color, weight: 3, opacity: 0.9
      }).addTo(state.mapInstance);
    }

    // Airplane heading line — only when exit (t=0) is in the visible window
    if (0 >= tMin && 0 <= tMax) {
      const exitTimeAbs = allTimes[exitIdx];
      let headingRefIdx = exitIdx;
      for (let i = exitIdx; i >= 0; i--) {
        if (exitTimeAbs - allTimes[i] >= 3) { headingRefIdx = i; break; }
      }
      const refLat = parseFloat(data[headingRefIdx].lat);
      const refLon = parseFloat(data[headingRefIdx].lon);
      const exitLat = parseFloat(data[exitIdx].lat);
      const exitLon = parseFloat(data[exitIdx].lon);
      if (!isNaN(refLat) && !isNaN(refLon) && !isNaN(exitLat) && !isNaN(exitLon) && headingRefIdx !== exitIdx) {
        const dLat = exitLat - refLat;
        const dLon = exitLon - refLon;
        const extendFactor = 8;
        const lineStart = [exitLat - dLat * extendFactor, exitLon - dLon * extendFactor];
        const lineEnd = [exitLat + dLat * extendFactor, exitLon + dLon * extendFactor];
        L.polyline([lineStart, lineEnd], {
          color: '#94a3b8', weight: 3, dashArray: '8, 8', opacity: 0.7
        }).addTo(state.mapInstance);
      }
    }

    // Markers — only those whose time falls within the visible window
    const startTime = chartTimes[0];
    if (startTime >= tMin && startTime <= tMax) {
      const startLat = parseFloat(data[0].lat);
      const startLon = parseFloat(data[0].lon);
      if (!isNaN(startLat) && !isNaN(startLon)) {
        L.circleMarker([startLat, startLon], {
          radius: 8, fillColor: themeAccent, color: '#000', weight: 2, fillOpacity: 1
        }).addTo(state.mapInstance).bindTooltip(t('map.start'), { permanent: true, direction: 'top', className: 'map-label' });
      }
    }

    if (0 >= tMin && 0 <= tMax) {
      const exitLat = parseFloat(data[exitIdx].lat);
      const exitLon = parseFloat(data[exitIdx].lon);
      if (!isNaN(exitLat) && !isNaN(exitLon)) {
        L.circleMarker([exitLat, exitLon], {
          radius: 8, fillColor: '#facc15', color: '#000', weight: 2, fillOpacity: 1
        }).addTo(state.mapInstance).bindTooltip(t('map.exit'), { permanent: true, direction: 'top', className: 'map-label' });
      }
    }

    if (canopyTimeRel >= tMin && canopyTimeRel <= tMax) {
      const canopyLat = parseFloat(data[canopyIdx].lat);
      const canopyLon = parseFloat(data[canopyIdx].lon);
      if (!isNaN(canopyLat) && !isNaN(canopyLon)) {
        L.circleMarker([canopyLat, canopyLon], {
          radius: 8, fillColor: '#f472b6', color: '#000', weight: 2, fillOpacity: 1
        }).addTo(state.mapInstance).bindTooltip(t('map.canopy'), { permanent: true, direction: 'top', className: 'map-label' });
      }
    }

    const landingTimeRel = chartTimes[landingIdx];
    if (landingTimeRel >= tMin && landingTimeRel <= tMax) {
      const landLat = parseFloat(data[landingIdx].lat);
      const landLon = parseFloat(data[landingIdx].lon);
      if (!isNaN(landLat) && !isNaN(landLon)) {
        L.circleMarker([landLat, landLon], {
          radius: 8, fillColor: '#4ade80', color: '#000', weight: 2, fillOpacity: 1
        }).addTo(state.mapInstance).bindTooltip(t('map.landing'), { permanent: true, direction: 'top', className: 'map-label' });
      }
    }

    if (pathCoords.length > 1) {
      state.mapInstance.fitBounds(L.latLngBounds(pathCoords).pad(0.15));
    }

    // Reverse hover: tooltip when mousing along the flight path
    const HOVER_THRESHOLD_PX = 20;
    state.mapInstance.on('mousemove', function(e) {
      if (!state.mapInstance) return;
      const cursor = e.containerPoint;
      let bestIdx = -1;
      let bestDistSq = HOVER_THRESHOLD_PX * HOVER_THRESHOLD_PX;
      for (let i = 0; i < windowLats.length; i++) {
        const lat = windowLats[i], lon = windowLons[i];
        if (isNaN(lat) || isNaN(lon)) continue;
        const pt = state.mapInstance.latLngToContainerPoint([lat, lon]);
        const dx = pt.x - cursor.x;
        const dy = pt.y - cursor.y;
        const dsq = dx * dx + dy * dy;
        if (dsq < bestDistSq) {
          bestDistSq = dsq;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) {
        if (state.mapHoverTooltip && state.mapHoverTooltip.isOpen()) {
          state.mapInstance.closeTooltip(state.mapHoverTooltip);
        }
        if (state.hoverMarker) {
          state.mapInstance.removeLayer(state.hoverMarker);
          state.hoverMarker = null;
        }
        clearChartActive();
        return;
      }

      const lat = windowLats[bestIdx];
      const lon = windowLons[bestIdx];
      const t = windowTimes[bestIdx];
      const alt = windowAlts[bestIdx];
      const vSpd = windowVertSpeeds[bestIdx];
      const hSpd = windowHorzSpeeds[bestIdx];

      const tStr = (t >= 0 ? 'T+' : 'T') + t.toFixed(1) + 's';
      const altM = isNaN(alt) ? '—' : Math.round(alt).toLocaleString() + ' m';
      const altFt = isNaN(alt) ? '' : Math.round(alt * 3.28084).toLocaleString() + ' ft';
      const vKmh = (vSpd * 3.6).toFixed(1);
      const vMph = (vSpd * 2.23694).toFixed(1);
      const hKmh = (hSpd * 3.6).toFixed(1);
      const hMph = (hSpd * 2.23694).toFixed(1);

      const html =
        '<div class="map-hover-tooltip-time">' + tStr + '</div>' +
        '<div class="map-hover-tooltip-row"><span class="map-hover-tooltip-label">' + t('map.alt') + '</span><span>' + altM + '</span><span class="map-hover-tooltip-imperial">' + altFt + '</span></div>' +
        '<div class="map-hover-tooltip-row"><span class="map-hover-tooltip-label">' + t('map.vert') + '</span><span>' + vKmh + ' km/h</span><span class="map-hover-tooltip-imperial">' + vMph + ' mph</span></div>' +
        '<div class="map-hover-tooltip-row"><span class="map-hover-tooltip-label">' + t('map.horz') + '</span><span>' + hKmh + ' km/h</span><span class="map-hover-tooltip-imperial">' + hMph + ' mph</span></div>';

      if (!state.mapHoverTooltip) {
        state.mapHoverTooltip = L.tooltip({
          permanent: false,
          direction: 'top',
          offset: [0, -8],
          className: 'map-hover-tooltip'
        });
      }
      state.mapHoverTooltip.setLatLng([lat, lon]).setContent(html);
      if (!state.mapHoverTooltip.isOpen()) {
        state.mapHoverTooltip.openOn(state.mapInstance);
      }

      if (!state.hoverMarker) {
        state.hoverMarker = L.circleMarker([lat, lon], {
          radius: 7, fillColor: '#fff', color: '#0f172a', weight: 2, fillOpacity: 1
        }).addTo(state.mapInstance);
      } else {
        state.hoverMarker.setLatLng([lat, lon]);
      }

      // Chart datasets contain full-data, so the chart index == windowFullIdx[bestIdx]
      setChartActiveAtIndex(windowFullIdx[bestIdx]);
    });

    state.mapInstance.on('mouseout', function() {
      if (state.mapHoverTooltip && state.mapHoverTooltip.isOpen()) {
        state.mapInstance.closeTooltip(state.mapHoverTooltip);
      }
      if (state.hoverMarker) {
        state.mapInstance.removeLayer(state.hoverMarker);
        state.hoverMarker = null;
      }
      clearChartActive();
    });
  }

  state.lastRenderMap = renderMap;

  const initialMin = showFull ? chartTimes[0] : -5;
  const initialMax = showFull ? chartTimes[chartTimes.length - 1] : (canopyTimeRel + 5);
  renderMap(initialMin, initialMax);

  // Expose flight data for video overlay sync. `landingTimeRel`/`canopyTimeRel`
  // (seconds relative to exit) let the export decide how far to run.
  const landingTimeRel = chartTimes[landingIdx];
  state.currentFlightData = { times, altitudes, vertSpeeds, horzSpeeds, diveAngles, lats: sliceLats, lons: sliceLons, velNs, velEs, exitIdx: exitIdx - startIdx, canopyIdx: canopyIdx - startIdx, speedScore, perfWindowStartTime, perfWindowEndTime, best3sStart, best3sEnd, canopyTimeRel, landingTimeRel };

  // Full-recording dataset (relative to exit), used by the video export's
  // "full descent" option to build an overlay-data slice that reaches landing.
  // Indices here are absolute (into the full arrays), unlike currentFlightData.
  state.currentFlightDataFull = {
    times: chartTimes, altitudes: chartAlts, vertSpeeds: chartVertSpeeds, horzSpeeds: chartHorzSpeeds,
    diveAngles: chartDiveAngles, lats: chartLats, lons: chartLons, velNs: chartVelNs, velEs: chartVelEs,
    exitIdx, canopyIdx, landingIdx, canopyTimeRel, landingTimeRel,
    speedScore, perfWindowStartTime, perfWindowEndTime, best3sStart, best3sEnd,
  };
}

// ── Chart right-click menu: "Set exit point here" ──
// Attached once to the persistent #chart canvas. Reads the live chart instance
// and state.exitEditCtx at event time, so it survives chart re-creation.
(function setupExitContextMenu() {
  function init() {
    const canvas = document.getElementById('chart');
    if (!canvas) return;

    let menu = null;
    function hideMenu() {
      if (menu) { menu.remove(); menu = null; }
      document.removeEventListener('click', hideMenu, true);
      document.removeEventListener('scroll', hideMenu, true);
    }

    canvas.addEventListener('contextmenu', function(e) {
      if (!state.chartInstance || !state.exitEditCtx) return;
      const ctx = state.exitEditCtx;
      const xValue = state.chartInstance.scales.x.getValueForPixel(e.offsetX);
      if (xValue == null || isNaN(xValue)) return;

      // Absolute recording-relative time of the clicked sample, clamped to data.
      const allTimes = ctx.allTimes;
      let targetRecTime = ctx.exitTimeRel + xValue;
      const lo = allTimes[0], hi = allTimes[allTimes.length - 1];
      if (targetRecTime < lo) targetRecTime = lo;
      if (targetRecTime > hi) targetRecTime = hi;

      e.preventDefault();
      hideMenu();

      menu = document.createElement('div');
      menu.className = 'chart-context-menu';

      const setItem = document.createElement('button');
      setItem.className = 'chart-context-item';
      setItem.textContent = t('ctx.setExit');
      setItem.addEventListener('click', function() {
        hideMenu();
        setExitOverride(state.currentJumpName, targetRecTime);
        renderCurrentJump(state.chartShowFull);
      });
      menu.appendChild(setItem);

      if (ctx.hasOverride) {
        const resetItem = document.createElement('button');
        resetItem.className = 'chart-context-item';
        resetItem.textContent = t('ctx.resetExit');
        resetItem.addEventListener('click', function() {
          hideMenu();
          clearExitOverride(state.currentJumpName);
          renderCurrentJump(state.chartShowFull);
        });
        menu.appendChild(resetItem);
      }

      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
      document.body.appendChild(menu);

      // Keep the menu on-screen if it would overflow the right/bottom edge.
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = (e.clientX - rect.width) + 'px';
      if (rect.bottom > window.innerHeight) menu.style.top = (e.clientY - rect.height) + 'px';

      // Dismiss on any click / scroll (capture so it fires before other handlers).
      setTimeout(() => {
        document.addEventListener('click', hideMenu, true);
        document.addEventListener('scroll', hideMenu, true);
      }, 0);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
