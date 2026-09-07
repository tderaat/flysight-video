// ── Wind estimation and wind-relative flight metrics ──
//
// The chart's Dive Angle series is computed from GPS *ground* velocity, which
// mixes in the wind. At the 76-80 km/h of upper wind measured on the 5
// September 2026 rounds that is enough to invert the apparent steepness of two
// jumps, so the number the app prints is not the number the flier controls.
// This module recovers the wind vector and derives the air-relative series.
//
// Method: in a coordinated turn an aircraft's ground-velocity vector traces a
// circle whose CENTRE is the wind vector and whose RADIUS is its airspeed. So
// a least-squares circle fit over the (velE, velN) hodograph of the pre-exit
// climb yields both. The climb is the only usable source — during freefall the
// jumper's own horizontal airspeed cannot be separated from the wind.
//
// Measured over the 61 scored speed jumps of the 2026 season: an estimate is
// produced for 55, and the recovered aircraft airspeed lands in 200-240 km/h
// on every one of them, which is what makes the fit trustworthy. The 6
// failures are recordings with no turning climb (trimmed files, straight-line
// climbs); those return null rather than a bad guess.
//
// Everything here is pure — no DOM, no `state`, no `t()`.

// Climb bands tried in order, as a fraction of exit AGL. The first band that
// passes every gate below wins. Starting high keeps the estimate close to the
// working altitude; the lower fallbacks catch a climb that only turns late.
var WIND_BANDS = [0.55, 0.28, 0.12];

var WIND_MIN_GROUND_SPEED = 20;      // m/s — excludes taxi and ground samples
var WIND_MIN_SAMPLES = 200;
var WIND_MIN_SECTORS = 8;            // of 12 30° heading bins, so >= 240° of turn
var WIND_MIN_AIRSPEED_KMH = 120;     // an implausible fit radius is a bad fit
var WIND_MAX_AIRSPEED_KMH = 400;
var WIND_MAX_FIT_RMS = 12;           // m/s of scatter about the fitted circle
var WIND_SECTOR_COUNT = 12;

// Below this the horizontal velocity direction is noise, so report no track.
var WIND_TRACK_MIN_SPEED = 1;        // m/s

// ── Over-steep / past-vertical thresholds ──
// Tunable in one place. Note the over-steep marker is INFORMATIONAL: across the
// 54 fully-scored 2026 jumps it fired on 18 (mean score 506.22) against 36 that
// did not fire (mean 503.86), so being steep does not predict a lower score.
// It marks where the dive crosses the threshold, it does not mark a mistake.
var STEEP_DIVE_MIN_DEG = 86;
var STEEP_HSPEED_MAX = 30 / 3.6;     // m/s
var STEEP_SUSTAIN_SEC = 1.0;
var STEEP_SMOOTH_HALF_SEC = 0.5;     // +-0.5 s moving average before thresholding

// A genuine backslide: the horizontal airspeed collapses to nothing and the
// air-relative track then swings right round. Fires on 3 of the 54 jumps.
var PASTVERT_HSPEED_MAX = 10 / 3.6;  // m/s
var PASTVERT_DIVE_MIN_DEG = 85;
var PASTVERT_ROTATION_DEG = 120;
var PASTVERT_ROTATION_SEC = 3;
var PASTVERT_WINDOW_SLACK_SEC = 3;   // allow onset just past the window end

// Kasa least-squares circle fit. Returns the centre, the mean radius and the
// RMS radial residual, or null when the normal matrix is degenerate (which is
// what a straight line of points produces).
function fitVelocityCircle(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i], z = x * x + y * y;
    Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y;
    Sxz += x * z; Syz += y * z; Sz += z;
  }
  const a11 = 2 * (Sxx - Sx * Sx / n);
  const a12 = 2 * (Sxy - Sx * Sy / n);
  const a22 = 2 * (Syy - Sy * Sy / n);
  const b1 = Sxz - Sx * Sz / n;
  const b2 = Syz - Sy * Sz / n;
  const det = a11 * a22 - a12 * a12;
  if (!isFinite(det) || Math.abs(det) < 1e-9) return null;
  const cx = (b1 * a22 - a12 * b2) / det;
  const cy = (a11 * b2 - b1 * a12) / det;
  let rSum = 0;
  for (let i = 0; i < n; i++) rSum += Math.sqrt((xs[i] - cx) * (xs[i] - cx) + (ys[i] - cy) * (ys[i] - cy));
  const r = rSum / n;
  let resid = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt((xs[i] - cx) * (xs[i] - cx) + (ys[i] - cy) * (ys[i] - cy)) - r;
    resid += d * d;
  }
  if (!isFinite(cx) || !isFinite(cy) || !isFinite(r)) return null;
  return { cx, cy, r, rms: Math.sqrt(resid / n) };
}

// Wind vector from the aircraft climb. `alts` / `velNs` / `velEs` are the
// full-recording arrays (they must include the pre-exit climb — the jump-window
// slices do not). Returns null when no band produces a trustworthy fit.
function estimateWind(alts, velNs, velEs, exitIdx, groundAlt) {
  if (!alts || !velNs || !velEs) return null;
  if (!isFinite(exitIdx) || exitIdx < 2) return null;
  const exitAGL = alts[exitIdx] - groundAlt;
  if (!isFinite(exitAGL) || exitAGL <= 0) return null;

  for (let b = 0; b < WIND_BANDS.length; b++) {
    const minAGL = exitAGL * WIND_BANDS[b];
    const xs = [], ys = [];
    for (let i = 1; i < exitIdx; i++) {
      const agl = alts[i] - groundAlt;
      if (!(agl >= minAGL)) continue;
      const vN = velNs[i], vE = velEs[i];
      if (!isFinite(vN) || !isFinite(vE)) continue;
      if (Math.sqrt(vN * vN + vE * vE) < WIND_MIN_GROUND_SPEED) continue;
      xs.push(vE); ys.push(vN);
    }
    if (xs.length < WIND_MIN_SAMPLES) continue;

    // Heading coverage: a straight jump run occupies one or two sectors and
    // cannot constrain the circle, so it must not be allowed to produce a fit.
    const seen = {};
    let sectors = 0;
    const sectorSize = (Math.PI * 2) / WIND_SECTOR_COUNT;
    for (let k = 0; k < xs.length; k++) {
      const ang = (Math.atan2(xs[k], ys[k]) + Math.PI * 2) % (Math.PI * 2);
      const s = Math.floor(ang / sectorSize);
      if (!seen[s]) { seen[s] = true; sectors++; }
    }
    if (sectors < WIND_MIN_SECTORS) continue;

    const fit = fitVelocityCircle(xs, ys);
    if (!fit) continue;
    const airspeedKmh = fit.r * 3.6;
    if (airspeedKmh < WIND_MIN_AIRSPEED_KMH || airspeedKmh > WIND_MAX_AIRSPEED_KMH) continue;
    if (fit.rms > WIND_MAX_FIT_RMS) continue;

    const wE = fit.cx, wN = fit.cy;
    const speedMs = Math.sqrt(wN * wN + wE * wE);
    return {
      wN: wN,
      wE: wE,
      speedMs: speedMs,
      speedKmh: speedMs * 3.6,
      // Meteorological convention: the direction the wind blows FROM.
      fromDeg: (Math.atan2(-wE, -wN) * (180 / Math.PI) + 360) % 360,
      airspeedKmh: airspeedKmh,
      rms: fit.rms,
      sectors: sectors,
      samples: xs.length,
      minAGL: minAGL
    };
  }
  return null;
}

// Air-relative horizontal speed, dive angle and track, per sample. With
// `wind` null this returns the ground-relative values unchanged, so callers
// can render something either way — but the markers below deliberately do not
// run in that case (see detectSteepMarkers).
function windRelativeSeries(velNs, velEs, velDs, wind) {
  const n = velDs.length;
  const hSpeeds = new Array(n), diveAngles = new Array(n), tracks = new Array(n);
  const wN = wind ? wind.wN : 0;
  const wE = wind ? wind.wE : 0;
  for (let i = 0; i < n; i++) {
    const aN = (velNs[i] || 0) - wN;
    const aE = (velEs[i] || 0) - wE;
    const h = Math.sqrt(aN * aN + aE * aE);
    hSpeeds[i] = h;
    const vd = velDs[i];
    diveAngles[i] = isFinite(vd) ? Math.atan2(vd, h) * (180 / Math.PI) : null;
    tracks[i] = h > WIND_TRACK_MIN_SPEED ? (Math.atan2(aE, aN) * (180 / Math.PI) + 360) % 360 : null;
  }
  return { hSpeeds: hSpeeds, diveAngles: diveAngles, tracks: tracks };
}

// Centred moving average over +-halfSec seconds of `times`. Time-based rather
// than sample-based so it behaves the same at FlySight 1's 10 Hz and FlySight
// 2's 5 Hz, and across the dropped samples FlySight 2 files contain.
function smoothOverSeconds(times, values, halfSec) {
  const n = values.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let j = i; j >= 0 && times[i] - times[j] <= halfSec; j--) {
      if (values[j] == null || !isFinite(values[j])) continue;
      sum += values[j]; count++;
    }
    for (let j = i + 1; j < n && times[j] - times[i] <= halfSec; j++) {
      if (values[j] == null || !isFinite(values[j])) continue;
      sum += values[j]; count++;
    }
    out[i] = count > 0 ? sum / count : null;
  }
  return out;
}

// Smallest signed difference between two compass bearings, in degrees.
function bearingDelta(a, b) {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// The two chart markers. `times` is exit-relative; `diveAir` / `hSpeedAir` /
// `trackAir` come from windRelativeSeries UNMASKED (not the null-masked copy
// used for the dataset). Both results are null without a wind estimate, so a
// marker is never placed off a wind-contaminated ground-relative angle.
function detectSteepMarkers(times, diveAir, hSpeedAir, trackAir, pStartT, pEndT, wind) {
  const empty = { overSteepT: null, pastVertT: null };
  if (!wind) return empty;
  if (pStartT === null || pEndT === null || !isFinite(pStartT) || !isFinite(pEndT)) return empty;

  const dive = smoothOverSeconds(times, diveAir, STEEP_SMOOTH_HALF_SEC);
  const hs = smoothOverSeconds(times, hSpeedAir, STEEP_SMOOTH_HALF_SEC);
  const n = times.length;

  let overSteepT = null;
  for (let i = 0; i < n; i++) {
    if (times[i] < pStartT || times[i] > pEndT) continue;
    if (dive[i] == null || hs[i] == null) continue;
    if (!(dive[i] >= STEEP_DIVE_MIN_DEG && hs[i] < STEEP_HSPEED_MAX)) continue;
    let sustained = true;
    for (let j = i; j < n && times[j] - times[i] <= STEEP_SUSTAIN_SEC; j++) {
      if (dive[j] == null || hs[j] == null ||
          !(dive[j] >= STEEP_DIVE_MIN_DEG && hs[j] < STEEP_HSPEED_MAX)) { sustained = false; break; }
    }
    if (sustained) { overSteepT = times[i]; break; }
  }

  let pastVertT = null;
  for (let i = 0; i < n; i++) {
    if (times[i] < pStartT || times[i] > pEndT + PASTVERT_WINDOW_SLACK_SEC) continue;
    if (dive[i] == null || hs[i] == null) continue;
    if (!(hs[i] < PASTVERT_HSPEED_MAX && dive[i] > PASTVERT_DIVE_MIN_DEG)) continue;
    const from = trackAir[i];
    if (from == null) continue;
    let maxRot = 0;
    for (let j = i; j < n && times[j] - times[i] <= PASTVERT_ROTATION_SEC; j++) {
      if (trackAir[j] == null) continue;
      const rot = Math.abs(bearingDelta(trackAir[j], from));
      if (rot > maxRot) maxRot = rot;
    }
    if (maxRot > PASTVERT_ROTATION_DEG) { pastVertT = times[i]; break; }
  }

  return { overSteepT: overSteepT, pastVertT: pastVertT };
}
