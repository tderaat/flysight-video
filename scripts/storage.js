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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jumps));
  } catch (e) {
    // Remove the jump we just added so state stays consistent
    if (existing < 0) jumps.pop();
    alert('Storage is full. Remove some jumps to free space before adding new ones.');
  }
}

function removeJump(name) {
  const jumps = getStoredJumps().filter(j => j.name !== name);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(jumps));
}
