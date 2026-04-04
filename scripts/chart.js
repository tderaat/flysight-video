
function renderCurrentJump(showFull) {
  const jumps = getStoredJumps();
  const jump = jumps.find(j => j.name === state.currentJumpName);
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

  const times = [], altitudes = [], vertSpeeds = [], horzSpeeds = [], diveAngles = [], sliceLats = [], sliceLons = [], velNs = [], velEs = [];
  for (let i = startIdx; i <= endIdx; i++) {
    times.push(allTimes[i] - exitTime);
    altitudes.push(allAlts[i]);
    vertSpeeds.push(allVelD[i]);
    const vN = parseFloat(data[i].velN) || 0;
    const vE = parseFloat(data[i].velE) || 0;
    const hSpd = Math.sqrt(vN * vN + vE * vE);
    horzSpeeds.push(hSpd);
    diveAngles.push(Math.atan2(allVelD[i], hSpd) * (180 / Math.PI));
    velNs.push(vN);
    velEs.push(vE);
    sliceLats.push(parseFloat(data[i].lat));
    sliceLons.push(parseFloat(data[i].lon));
  }

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
  if (state.chartInstance) state.chartInstance.destroy();

  const ctx = document.getElementById('chart').getContext('2d');
  state.chartInstance = new Chart(ctx, {
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
        },
        {
          label: 'Dive Angle (°)',
          data: diveAngles,
          borderColor: '#f472b6',
          backgroundColor: 'rgba(244,114,182,0.08)',
          fill: false,
          yAxisID: 'yAngle',
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
        if (elements.length > 0 && state.mapInstance) {
          const idx = elements[0].index;
          const lat = sliceLats[idx];
          const lon = sliceLons[idx];
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
              } else if (ctx.datasetIndex === 2) {
                return ' Ground Speed: ' + ctx.parsed.y.toFixed(0) + ' km/h';
              } else {
                return ' Dive Angle: ' + ctx.parsed.y.toFixed(1) + '°';
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
          title: { display: true, text: 'Speed (km/h)', color: '#4ade80' },
          ticks: { color: '#4ade80' },
          grid: { drawOnChartArea: false }
        },
        yAngle: {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 90,
          title: { display: true, text: 'Dive Angle (°)', color: '#f472b6' },
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

  if (state.mapInstance) { state.mapInstance.remove(); state.mapInstance = null; }
  state.hoverMarker = null;

  state.mapInstance = L.map('map', { attributionControl: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19
  }).addTo(state.mapInstance);

  const exitPathIdx = exitIdx - startIdx;
  const canopyPathIdx = canopyIdx - startIdx;

  for (let i = 0; i < pathCoords.length - 1; i++) {
    let color;
    if (i < exitPathIdx) color = '#38bdf8';
    else if (i < canopyPathIdx) color = '#ef4444';
    else color = '#1e1e1e';
    L.polyline([pathCoords[i], pathCoords[i + 1]], {
      color,
      weight: 3,
      opacity: 0.9
    }).addTo(state.mapInstance);
  }

  // Airplane heading line
  const exitTimeAbs = allTimes[exitIdx];
  let headingRefIdx = exitIdx;
  for (let i = exitIdx; i >= 0; i--) {
    if (exitTimeAbs - allTimes[i] >= 3) { headingRefIdx = i; break; }
  }
  const refLat = parseFloat(data[headingRefIdx].lat);
  const refLon = parseFloat(data[headingRefIdx].lon);

  if (!isNaN(refLat) && !isNaN(refLon) && !isNaN(exitLat) && !isNaN(exitLon) && headingRefIdx !== exitIdx) {
    const dLat = exitLat - refLat;
    const dLon = exitLon - refLon;
    const extendFactor = 8;
    const lineStart = [exitLat - dLat * extendFactor, exitLon - dLon * extendFactor];
    const lineEnd = [exitLat + dLat * extendFactor, exitLon + dLon * extendFactor];
    L.polyline([lineStart, lineEnd], {
      color: '#94a3b8',
      weight: 3,
      dashArray: '8, 8',
      opacity: 0.7
    }).addTo(state.mapInstance);
  }

  if (!isNaN(exitLat) && !isNaN(exitLon)) {
    L.circleMarker([exitLat, exitLon], {
      radius: 8, fillColor: '#facc15', color: '#000', weight: 2, fillOpacity: 1
    }).addTo(state.mapInstance).bindTooltip('Exit', { permanent: true, direction: 'top', className: 'map-label' });
  }

  if (!isNaN(landLat) && !isNaN(landLon)) {
    L.circleMarker([landLat, landLon], {
      radius: 8, fillColor: '#4ade80', color: '#000', weight: 2, fillOpacity: 1
    }).addTo(state.mapInstance).bindTooltip('Landing', { permanent: true, direction: 'top', className: 'map-label' });
  }

  if (pathCoords.length > 1) {
    state.mapInstance.fitBounds(L.latLngBounds(pathCoords).pad(0.15));
  }

  // Expose flight data for video overlay sync
  state.currentFlightData = { times, altitudes, vertSpeeds, horzSpeeds, diveAngles, lats: sliceLats, lons: sliceLons, velNs, velEs, exitIdx: exitIdx - startIdx, canopyIdx: canopyIdx - startIdx, speedScore, perfWindowStartTime, perfWindowEndTime, best3sStart, best3sEnd };
}
