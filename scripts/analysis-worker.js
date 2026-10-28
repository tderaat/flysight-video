// ── Web Worker: analyseJumpSummary() off the main thread ──
// Loads the same pure scripts the page uses, so a summary computed here is
// identical to one computed by the page. Driven by analyseJumpInBackground()
// in scripts/season.js; message in { id, csv, override }, out { id, summary }
// or { id, error }. Paths resolve relative to this file.
importScripts('../vendor/papaparse.min.js', 'csv.js', 'analysis.js');

// Assigned after importScripts on purpose: PapaParse sets its own onmessage
// when it detects a worker, and this one has to win.
self.onmessage = function (e) {
  var msg = e.data;
  try {
    self.postMessage({ id: msg.id, summary: analyseJumpSummary(msg.csv, msg.override) });
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
};
