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
