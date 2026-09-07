// ── CSV Parsing ──
// Two on-disk formats are supported:
//
//  • FlySight 1 — a plain CSV: header row, units row, then data rows.
//    Fractional seconds are centiseconds (`...:08.10Z`). 10 Hz.
//  • FlySight 2 — a "$"-tagged record format, one tag per line:
//        $FLYS,1
//        $VAR,FIRMWARE_VER,v2025.05.25
//        $COL,GNSS,time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,numSV
//        $UNIT,GNSS,,deg,deg,m,m/s,m/s,m/s,m,m,m/s,
//        $DATA
//        $GNSS,2025-...,...
//    Only the GNSS track is consumed; other sensor records ($IMU, $BARO,
//    $MAG, …) and the metadata tags are ignored. Defaults to 5 Hz.
//
// FlySight 2 also ships tooling that exports the FlySight 1 column layout but
// with millisecond (3-digit) fractional seconds and an empty `gpsFix` column.
// That variant goes through the row-based path below; `parseTimestamp` reads
// the fraction as a decimal so 1-, 2- and 3-digit fractions all work.
//
// Both paths return the same shape: an array of plain objects keyed by column
// name, values as strings (callers parseFloat/parseInt what they need).

// Column order used by FlySight 2 GNSS records when a $COL line is absent.
var FS2_GNSS_DEFAULT_COLS = ['time', 'lat', 'lon', 'hMSL', 'velN', 'velE', 'velD', 'hAcc', 'vAcc', 'sAcc', 'numSV'];

function looksLikeDataRow(line) {
  return !!line && /^\s*\d{4}-\d{2}-\d{2}T/.test(line);
}

function isFlySight2CSV(csvText) {
  return /^\s*\$FLYS\b/.test(csvText) || /^\s*\$(COL|GNSS)\s*,/m.test(csvText);
}

function parseFlySightCSV(csvText) {
  if (!csvText) return [];
  if (isFlySight2CSV(csvText)) return parseFlySight2CSV(csvText);

  const lines = csvText.trim().split(/\r?\n/);
  // Row 1 is the units row on every FlySight 1 CSV. Only skip it when it
  // isn't itself a data row, so a converter that omits it still parses.
  const body = looksLikeDataRow(lines[1]) ? lines.slice(1) : lines.slice(2);
  const cleaned = [lines[0], ...body].join('\n');
  const result = Papa.parse(cleaned, { header: true, skipEmptyLines: true });
  return result.data.filter(r => r && r.time);
}

function parseFlySight2CSV(csvText) {
  const lines = csvText.split(/\r?\n/);
  let cols = null;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const f = line.split(',');
    const tag = f[0];
    if (tag === '$COL') {
      // $COL,<sensor>,<name>,<name>,… — only the GNSS track is used.
      if (f[1] === 'GNSS') cols = f.slice(2).map(c => c.trim());
    } else if (tag === '$GNSS') {
      const names = cols || FS2_GNSS_DEFAULT_COLS;
      const row = {};
      for (let c = 0; c < names.length; c++) row[names[c]] = (f[c + 1] || '').trim();
      if (row.time) rows.push(row);
    }
    // $FLYS / $VAR / $UNIT / $DATA and other sensor records are ignored.
  }
  return rows;
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
  // The fraction is read as a decimal fraction of a second, so its length
  // doesn't matter: FlySight 1 writes centiseconds (".10" → 100 ms),
  // FlySight 2 writes milliseconds (".400" → 400 ms).
  let ms = 0;
  if (frac) {
    const digits = frac.replace(/[^0-9]/g, '').slice(0, 3);
    if (digits) ms = Math.round(Number(digits) * Math.pow(10, 3 - digits.length));
  }
  return Date.UTC(y, mo-1, d, Number(h), Number(mi), Number(sec), ms);
}

// Median sample interval in seconds. FlySight 1 logs at 10 Hz (0.1 s) while
// FlySight 2 defaults to 5 Hz (0.2 s) and is configurable, so every sustain /
// validation window in detectExitAndLanding is written in seconds and turned
// into a sample count with this. Median rather than mean so that dropped
// samples (the FlySight 2 sample file has gaps up to 2.8 s) don't skew it.
function estimateSampleInterval(data) {
  if (!data || data.length < 2) return 0.1;
  const step = Math.max(1, Math.floor(data.length / 200));
  const dts = [];
  for (let i = 1; i < data.length; i += step) {
    const dt = (parseTimestamp(data[i].time) - parseTimestamp(data[i - 1].time)) / 1000;
    if (isFinite(dt) && dt > 0 && dt < 5) dts.push(dt);
  }
  if (!dts.length) return 0.1;
  dts.sort((a, b) => a - b);
  const med = dts[dts.length >> 1];
  return med > 0 && med <= 2 ? med : 0.1;
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

  // Sample counts for the time-based windows below, derived from the file's
  // own logging rate so the same thresholds hold for 10 Hz and 5 Hz data.
  const sampleDt = estimateSampleInterval(data);
  const samplesFor = sec => Math.max(2, Math.round(sec / sampleDt));

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
    const ONSET_SUSTAIN_SAMPLES = samplesFor(2);      // ~2 s of sustained descent
    const VALIDATION_WINDOW_SAMPLES = samplesFor(5);  // ~5 s to reach freefall
    exitIdx = maxIdx;
    for (let i = maxIdx; i < data.length - ONSET_SUSTAIN_SAMPLES; i++) {
      let sustained = true;
      for (let j = i; j < i + ONSET_SUSTAIN_SAMPLES && j < data.length; j++) {
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
  const LANDING_SUSTAIN_SAMPLES = samplesFor(2); // ~2 s
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
  const CANOPY_SUSTAIN_SAMPLES = samplesFor(1); // ~1 s
  let canopyIdx = landingIdx;
  let wasInFreefall = false;
  for (let i = exitIdx; i < data.length - CANOPY_SUSTAIN_SAMPLES; i++) {
    if (veld[i] > 30) wasInFreefall = true;
    if (wasInFreefall && veld[i] < 15) {
      let sustained = true;
      for (let j = i; j < i + CANOPY_SUSTAIN_SAMPLES && j < data.length; j++) {
        if (veld[j] >= 15) { sustained = false; break; }
      }
      if (sustained) { canopyIdx = i; break; }
    }
  }

  return { exitIdx, landingIdx, canopyIdx };
}
