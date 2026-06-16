// ── CSV Parsing ──
function parseFlySightCSV(csvText) {
  const lines = csvText.trim().split('\n');
  const cleaned = [lines[0], ...lines.slice(2)].join('\n');
  const result = Papa.parse(cleaned, { header: true, skipEmptyLines: true });
  return result.data;
}

function parseTimestamp(s) {
  // FlySight CSV times are in UTC (`...Z` suffix). Parse as UTC so that
  // absolute timestamps round-trip to the user's local time correctly when
  // formatted with Date#getHours / toLocaleTimeString. Relative differences
  // are unchanged because every row uses the same parser.
  const [datePart, timePart] = s.replace('Z','').split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, rest] = timePart.split(':');
  const [sec, frac] = rest.split('.');
  return Date.UTC(y, mo-1, d, Number(h), Number(mi), Number(sec), Number(frac || 0) * 10);
}

// `forcedExitIdx` (optional): when a finite index is supplied, automatic exit
// detection is skipped and exit is pinned to that data row. Canopy and landing
// detection still run relative to it. Used by the chart's "Set exit point here"
// context-menu action to let the user correct a mis-detected exit.
function detectExitAndLanding(data, forcedExitIdx) {
  const alts = data.map(r => parseFloat(r.hMSL));
  const veld = data.map(r => parseFloat(r.velD));
  const veln = data.map(r => parseFloat(r.velN));
  const vele = data.map(r => parseFloat(r.velE));
  const maxAlt = Math.max(...alts);
  const maxIdx = alts.indexOf(maxAlt);

  let exitIdx;
  if (Number.isFinite(forcedExitIdx) && forcedExitIdx >= 0 && forcedExitIdx < data.length) {
    exitIdx = forcedExitIdx;
  } else {
    // Exit: sustained velD > 5 m/s, validated by reaching freefall speed
    // (>= 40 km/h ≈ 11.11 m/s) within ~5 seconds. The 5 m/s onset sits
    // well above plausible airplane dive rates (~3-4 m/s), which would
    // otherwise satisfy a lower threshold and anchor exit too early.
    const FREEFALL_ONSET_MPS = 5;
    const FREEFALL_VALIDATION_MPS = 40 / 3.6;
    const VALIDATION_WINDOW_SAMPLES = 50;
    exitIdx = maxIdx;
    for (let i = maxIdx; i < data.length - 20; i++) {
      let sustained = true;
      for (let j = i; j < i + 20 && j < data.length; j++) {
        if (veld[j] <= FREEFALL_ONSET_MPS) { sustained = false; break; }
      }
      if (!sustained) continue;

      let reachedFreefall = false;
      const validationEnd = Math.min(i + VALIDATION_WINDOW_SAMPLES, data.length);
      for (let k = i; k < validationEnd; k++) {
        if (veld[k] >= FREEFALL_VALIDATION_MPS) { reachedFreefall = true; break; }
      }
      if (reachedFreefall) { exitIdx = i; break; }
    }
  }

  // Landing: alt near min, AND for the next ~2 seconds all of:
  //   |velD| < 1 m/s, ground speed < 2 km/h, altitude drift < 2 m.
  // The unit must be essentially stationary — this rejects mid-air swoops,
  // flares and post-touchdown walking, and locks onto the moment the
  // skydiver has actually come to rest on the ground.
  const LANDING_VEL_D_MAX = 1.0;          // m/s
  const LANDING_GROUND_SPEED_MAX = 2 / 3.6; // m/s ≈ 2 km/h
  const LANDING_ALT_DRIFT_MAX = 2.0;       // metres over the sustain window
  const LANDING_SUSTAIN_SAMPLES = 20;      // ~2 s at 10 Hz
  const minAlt = Math.min(...alts.slice(maxIdx));
  let landingIdx = data.length - 1;
  for (let i = maxIdx; i < data.length - LANDING_SUSTAIN_SAMPLES; i++) {
    if (alts[i] >= minAlt + 15) continue;

    let valid = true;
    let altMin = alts[i], altMax = alts[i];
    for (let j = i; j < i + LANDING_SUSTAIN_SAMPLES; j++) {
      if (Math.abs(veld[j]) >= LANDING_VEL_D_MAX) { valid = false; break; }
      const gs = Math.sqrt(veln[j] * veln[j] + vele[j] * vele[j]);
      if (gs >= LANDING_GROUND_SPEED_MAX) { valid = false; break; }
      if (alts[j] < altMin) altMin = alts[j];
      if (alts[j] > altMax) altMax = alts[j];
    }
    if (!valid) continue;
    if (altMax - altMin >= LANDING_ALT_DRIFT_MAX) continue;

    landingIdx = i;
    break;
  }

  // Canopy opening: after exit, velD was high (freefall) then drops below 15 m/s sustained
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
