// ── FAI scoring, shared by the chart and the season view ──
// Pure functions: no DOM, no state, no t(). renderCurrentJump() (chart.js) uses
// the window and score helpers on the jump it is drawing; analyseJumpSummary()
// runs the same pipeline on any stored CSV, so the season view can score jumps
// that were never opened.
//
// Rules from the 2026 FAI ISC Competition Rules for speed skydiving.
var PERF_WINDOW_HEIGHT = 7400 * 0.3048;     // window end: 7,400 ft below window start
var BREAKOFF_AGL = 5600 * 0.3048;           // or breakoff, 5,600 ft AGL, whichever is higher
var PERF_WINDOW_VELD_START = 10;            // window starts when velD first reaches 10 m/s
var SCORE_WINDOW_SEC = 3;                   // fastest exactly-3-second window
var SCORE_TIME_DELTA = 0.005;               // sample-time tolerance for that window
var EXIT_MIN_AGL = 3962;                    // 13,000 ft
var EXIT_MAX_AGL = 4267;                    // 14,000 ft

// Bump when anything below changes the result, so cached season scores recompute.
var ANALYSIS_VERSION = 1;

// Performance window over exit-relative arrays (seconds, m MSL, m/s down).
// The start is interpolated between the two samples bracketing 10 m/s.
function computePerformanceWindow(times, altitudes, vertSpeeds, groundAlt) {
  const breakoffAltMSL = groundAlt + BREAKOFF_AGL;
  let perfWindowStartTime = null;
  let perfWindowStartAlt = null;
  for (let i = 1; i < times.length; i++) {
    if (times[i] < 0) continue;
    if (vertSpeeds[i] >= PERF_WINDOW_VELD_START) {
      if (times[i - 1] >= 0 && vertSpeeds[i - 1] < PERF_WINDOW_VELD_START) {
        const frac = (PERF_WINDOW_VELD_START - vertSpeeds[i - 1]) / (vertSpeeds[i] - vertSpeeds[i - 1]);
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
  return { perfWindowStartTime, perfWindowStartAlt, perfWindowEndTime, perfWindowEndAlt };
}

// Speed score, the FlySight Viewer Qt algorithm: altitude displacement over the
// fastest exactly-3-second window, scanned backwards, with the window bottom
// above breakoff and above the from-exit limit, and starting at or after exit.
// Returns km/h, or null when there is no window.
function computeSpeedScore(times, altitudes, groundAlt, win) {
  let speedScore = null, best3sStart = null, best3sEnd = null;
  if (win.perfWindowStartTime === null || win.perfWindowEndTime === null) {
    return { speedScore, best3sStart, best3sEnd };
  }
  const altsAGL = altitudes.map(a => a - groundAlt);
  const perfStartAltAGL = win.perfWindowStartAlt - groundAlt;

  let maxScore = 0;
  let iStart = times.length - 1;
  for (let iEnd = times.length - 1; iEnd >= 0; iEnd--) {
    const tStart = times[iEnd] - SCORE_WINDOW_SEC;
    while (iStart >= 0 && times[iStart] > tStart + SCORE_TIME_DELTA) iStart--;
    if (iStart < 0) break;
    if (times[iStart] < 0) break;
    if (altsAGL[iEnd] < perfStartAltAGL - PERF_WINDOW_HEIGHT) continue;
    if (altsAGL[iEnd] < BREAKOFF_AGL) continue;
    if (times[iStart] < tStart - SCORE_TIME_DELTA) continue;

    const score = (altsAGL[iStart] - altsAGL[iEnd]) / (times[iEnd] - times[iStart]);
    if (score > maxScore) {
      maxScore = score;
      best3sStart = times[iStart];
      best3sEnd = times[iEnd];
    }
  }
  if (maxScore > 0) speedScore = maxScore * 3.6;
  return { speedScore, best3sStart, best3sEnd };
}

function isExitAltitudeValid(exitAltAGL) {
  return exitAltAGL >= EXIT_MIN_AGL && exitAltAGL <= EXIT_MAX_AGL;
}

// Index of the sample nearest a recording-relative time (a manual exit override).
function nearestSampleIndex(allTimes, sec) {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < allTimes.length; i++) {
    const d = Math.abs(allTimes[i] - sec);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

// The figures the season view needs for one stored jump, computed exactly as
// renderCurrentJump() does on its default view: { score (km/h or null),
// exitAglM, exitValid, exitMs (UTC epoch ms of the exit) }. Null when the file
// has too little data to analyse.
function analyseJumpSummary(csv, exitOverrideSec) {
  const data = parseFlySightCSV(csv);
  if (data.length < 50) return null;
  const firstT = parseTimestamp(data[0].time);
  const allTimes = data.map(r => (parseTimestamp(r.time) - firstT) / 1000);
  const allAlts = data.map(r => parseFloat(r.hMSL));
  const allVelD = data.map(r => parseFloat(r.velD));

  const forcedExitIdx = exitOverrideSec !== null && exitOverrideSec !== undefined
    ? nearestSampleIndex(allTimes, exitOverrideSec) : undefined;
  const { exitIdx, landingIdx, canopyIdx } = detectExitAndLanding(data, forcedExitIdx);
  const exitTime = allTimes[exitIdx];

  // The jump slice the chart's stats use: 5 s before exit through canopy + 5 s.
  let startIdx = allTimes.findIndex(t => t >= exitTime - 5);
  let endIdx = allTimes.findIndex(t => t >= allTimes[canopyIdx] + 5);
  if (startIdx < 0) startIdx = 0;
  if (endIdx < 0) endIdx = data.length - 1;
  const times = [], altitudes = [], vertSpeeds = [];
  for (let i = startIdx; i <= endIdx; i++) {
    times.push(allTimes[i] - exitTime);
    altitudes.push(allAlts[i]);
    vertSpeeds.push(allVelD[i]);
  }

  const groundAlt = allAlts[landingIdx];
  const win = computePerformanceWindow(times, altitudes, vertSpeeds, groundAlt);
  const { speedScore } = computeSpeedScore(times, altitudes, groundAlt, win);
  const exitAglM = allAlts[exitIdx] - groundAlt;
  return {
    score: speedScore,
    exitAglM,
    exitValid: isExitAltitudeValid(exitAglM),
    exitMs: firstT + exitTime * 1000
  };
}
