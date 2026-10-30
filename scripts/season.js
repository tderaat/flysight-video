// ── Season overview ──
// One graph: the speed score of every stored jump in date order, a tab per
// season (calendar year of the exit, UTC) plus "All seasons", invalid exits in
// red, and a dashed personal-best line. Invalid exits still count, for the
// personal best too. Clicking a dot closes the modal and opens that jump.
//
// Scores come from analyseJumpSummary() (scripts/analysis.js), so jumps that
// were never opened are scored too. Analysing a CSV takes a few hundred ms, so
// results are cached in localStorage under SEASON_CACHE_KEY, keyed by jump name
// and checked against the jump index's csvKey (storage.js), the exit override
// and ANALYSIS_VERSION. Only the first open after an upload pays the cost, and
// an open with everything cached reads no CSV.
const SEASON_CACHE_KEY = 'flysight_season_cache';
const SEASON_ALL = 'all';
// Jumps the user hid with a right-click on their dot, as { name: true } (same
// shape as flysight_notes, so a rename carries it over). Left off the graph,
// the count and the personal best; never deleted.
const SEASON_HIDDEN_KEY = 'flysight_season_hidden';
// Scores under this get their own orange dot type, so the
// slow runs can be switched off from the legend in one click.
const SEASON_SLOW_KMH = 350;
const SEASON_SLOW_COLOR = '#f97316';
const SEASON_INVALID_COLOR = '#ef4444';
// Legend items switched off, as a JSON array of keys: the dot types 'jump',
// 'invalid' and 'slow', and the lines 'trend' and 'pb'. Kept across opens.
// Until the user first toggles one, the slow runs start switched off.
const SEASON_LEGEND_OFF_KEY = 'flysight_season_legend_off';
const SEASON_LEGEND_OFF_DEFAULT = ['slow'];

let seasonChart = null;
let seasonYear = null;        // selected tab: a year number or SEASON_ALL
let seasonEntries = [];       // [{ name, score, exitAglM, exitValid, exitMs }], scored, date order
let seasonAllEntries = null;  // every analysed jump, scored or not
let seasonKindsPresent = new Set(); // dot types in the tab before legend toggles
let seasonOpenSeq = 0;

function readSeasonCache() {
  try { return JSON.parse(localStorage.getItem(SEASON_CACHE_KEY) || '{}'); }
  catch (e) { return {}; }
}

function writeSeasonCache(cache) {
  try { localStorage.setItem(SEASON_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
}

function getSeasonHidden() {
  try { return JSON.parse(localStorage.getItem(SEASON_HIDDEN_KEY) || '{}'); }
  catch (e) { return {}; }
}

function writeSeasonHidden(map) {
  try {
    if (Object.keys(map).length) localStorage.setItem(SEASON_HIDDEN_KEY, JSON.stringify(map));
    else localStorage.removeItem(SEASON_HIDDEN_KEY);
  } catch (e) { /* ignore */ }
}

function setSeasonHidden(names, hidden) {
  const map = getSeasonHidden();
  names.forEach(n => { if (hidden) map[n] = true; else delete map[n]; });
  writeSeasonHidden(map);
}

// One type per dot. Slow wins over an invalid exit: the point of the slow type
// is to clear the slow runs out in one go, whatever their exit.
function seasonDotKind(e) {
  if (e.score < SEASON_SLOW_KMH) return 'slow';
  return e.exitValid ? 'jump' : 'invalid';
}

function getSeasonLegendOff() {
  try {
    const raw = localStorage.getItem(SEASON_LEGEND_OFF_KEY);
    return new Set(raw === null ? SEASON_LEGEND_OFF_DEFAULT : JSON.parse(raw));
  } catch (e) { return new Set(SEASON_LEGEND_OFF_DEFAULT); }
}

function toggleSeasonLegend(key) {
  const off = getSeasonLegendOff();
  if (off.has(key)) off.delete(key); else off.add(key);
  // An empty list is written, not removed: removing it would bring the
  // default back and switch the slow runs off again.
  try { localStorage.setItem(SEASON_LEGEND_OFF_KEY, JSON.stringify(Array.from(off))); } catch (e) { /* ignore */ }
  renderSeasonView();
}

// FNV-1a over the whole CSV, plus its length: what cache rows held before
// csvKey. Only used to carry those rows over without analysing them again.
function csvFingerprint(csv) {
  let h = 0x811c9dc5;
  for (let i = 0; i < csv.length; i++) {
    h ^= csv.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return csv.length + ':' + (h >>> 0).toString(16);
}

// ── Background analysis (Web Worker) ──
// Analysing a CSV takes a few hundred ms, so it runs in a worker
// (scripts/analysis-worker.js) where one can be started. Chrome refuses a
// Worker on a file:// page, so there, and if the worker fails to load, the
// same function runs on the main thread with a yield before each jump.
// Jobs go to the worker one at a time: posting a whole season at once would
// copy every CSV into the worker's memory together.
let analysisWorker = null;            // the Worker; false once ruled out
let analysisJobId = 0;
const analysisJobs = new Map();       // job id -> resolve

function getAnalysisWorker() {
  if (analysisWorker === null) {
    analysisWorker = false;
    if (location.protocol !== 'file:' && typeof Worker === 'function') {
      try {
        const w = new Worker('scripts/analysis-worker.js');
        w.onmessage = e => {
          const resolve = analysisJobs.get(e.data.id);
          if (!resolve) return;
          analysisJobs.delete(e.data.id);
          resolve(e.data);
        };
        // Only a script that failed to load gets here (the worker catches its
        // own analysis errors): give up on it and hand pending jobs back.
        w.onerror = e => {
          e.preventDefault();
          w.terminate();
          analysisWorker = false;
          const pending = Array.from(analysisJobs.values());
          analysisJobs.clear();
          pending.forEach(resolve => resolve({ failed: true }));
        };
        analysisWorker = w;
      } catch (e) { /* stays false */ }
    }
  }
  return analysisWorker || null;
}

// analyseJumpSummary(), in the worker when there is one.
async function analyseJumpInBackground(csv, override) {
  const w = getAnalysisWorker();
  if (w) {
    const res = await new Promise(resolve => {
      const id = ++analysisJobId;
      analysisJobs.set(id, resolve);
      w.postMessage({ id, csv, override });
    });
    if (res.error) throw new Error(res.error);
    if (!res.failed) return res.summary;
  }
  // A timeout rather than rAF, which never fires in a background tab.
  await new Promise(r => setTimeout(r, 0));
  return analyseJumpSummary(csv, override);
}

// After an import: score the new and changed jumps in the background so the
// season view opens from cache. Only with a worker: on the main thread it
// would make the page stutter for as long as the batch takes, and the season
// view does the same work with a progress line when opened. Runs are queued,
// and each row is merged into the cache as it lands.
let seasonWarmQueue = Promise.resolve();
function warmSeasonCache(names) {
  if (!getAnalysisWorker()) return;
  seasonWarmQueue = seasonWarmQueue.then(async () => {
    for (const name of names) {
      const j = await getJump(name);
      if (!j) continue;
      const override = getExitOverride(j.name);
      const key = csvQuickKey(j.csv);
      const row = readSeasonCache()[j.name];
      if (row && row.v === ANALYSIS_VERSION && row.key === key && row.override === override) continue;
      let s = null;
      try { s = await analyseJumpInBackground(j.csv, override); } catch (e) { console.warn('Season: could not analyse', j.name, e); }
      const cache = readSeasonCache();
      cache[j.name] = { v: ANALYSIS_VERSION, key, override, summary: s };
      writeSeasonCache(cache);
    }
  }).catch(e => console.warn('Season: background analysis failed', e));
}

// Analyse every stored jump, reusing the cache where it is still valid.
// Resolves null if a newer open superseded it.
async function analyseSeasonJumps(onProgress) {
  const seq = ++seasonOpenSeq;
  // The jump index, not getStoredJumps(): a cached row is checked against the
  // index's csvKey, so an open with everything cached reads no CSV at all.
  // Only jumps that need analysing are read, one at a time.
  const jumps = await getJumpIndex();
  const cache = readSeasonCache();
  const fresh = {};
  const out = [];
  let dirty = false;
  for (let i = 0; i < jumps.length; i++) {
    if (seq !== seasonOpenSeq) return null;
    const name = jumps[i].name;
    const key = jumps[i].csvKey;
    const override = getExitOverride(name);
    let row = cache[name];
    const current = row && row.v === ANALYSIS_VERSION && row.override === override;
    if (!current || row.key !== key) {
      const j = await getJump(name);
      if (seq !== seasonOpenSeq) return null;
      if (!j) continue;
      if (current && !row.key && row.fp === csvFingerprint(j.csv)) {
        // A row from before csvKey: its full fingerprint still proves the CSV
        // unchanged, so keep the summary and switch the row to the key.
        row = { v: ANALYSIS_VERSION, key, override, summary: row.summary };
      } else {
        onProgress(i, jumps.length);
        let s = null;
        try { s = await analyseJumpInBackground(j.csv, override); } catch (e) { console.warn('Season: could not analyse', name, e); }
        if (seq !== seasonOpenSeq) return null;
        row = { v: ANALYSIS_VERSION, key, override, summary: s };
      }
      dirty = true;
    }
    fresh[name] = row;
    if (row.summary) out.push(Object.assign({ name }, row.summary));
  }
  // Rewriting only from `fresh` also drops entries for deleted or renamed jumps.
  if (dirty || Object.keys(cache).length !== Object.keys(fresh).length) writeSeasonCache(fresh);
  // Same for hidden flags. A deleted jump keeps its flag until here, so an
  // undo of the delete brings it back still hidden.
  const hidden = getSeasonHidden();
  const keptHidden = {};
  Object.keys(hidden).forEach(n => { if (fresh[n]) keptHidden[n] = true; });
  if (Object.keys(keptHidden).length !== Object.keys(hidden).length) writeSeasonHidden(keptHidden);
  out.sort((a, b) => a.exitMs - b.exitMs);
  return out;
}

// Placeholder dots for the loading skeleton: a gentle rising wave, so the
// shape reads as "a graph is coming" without looking like real data.
const SEASON_SKELETON_DOTS = 28;
function buildSeasonSkeleton() {
  const box = document.getElementById('seasonSkeleton');
  if (box.childElementCount) return;
  for (let i = 0; i < SEASON_SKELETON_DOTS; i++) {
    const d = document.createElement('span');
    const x = 4 + (i / (SEASON_SKELETON_DOTS - 1)) * 92;
    const y = 62 - i * 0.9 - Math.sin(i * 0.9) * 9 - Math.sin(i * 2.3) * 5;
    d.style.left = x + '%';
    d.style.top = y + '%';
    d.style.animationDelay = (i * 40) + 'ms';
    box.appendChild(d);
  }
}

// The skeleton shows from the moment the modal opens until the first render,
// in place of the summary, legend and graph left over from the last open.
function setSeasonLoading(on) {
  document.querySelector('#seasonModal .season-modal').classList.toggle('loading', on);
  document.getElementById('seasonSkeleton').hidden = !on;
}

async function openSeasonModal() {
  document.getElementById('seasonModal').classList.add('open');
  buildSeasonSkeleton();
  setSeasonLoading(true);
  document.getElementById('seasonEmpty').hidden = true;
  const status = document.getElementById('seasonStatus');
  status.hidden = true;
  // Only shows the progress line when there is real work, so a cached open
  // doesn't flash it.
  const all = await analyseSeasonJumps((done, total) => {
    status.hidden = false;
    status.textContent = t('season.analysing', { done: done + 1, total });
  });
  if (all === null) return;
  status.hidden = true;
  setSeasonLoading(false);
  seasonAllEntries = all;
  const years = seasonYears();
  // Opens on "All seasons" when that tab exists, else on the only season.
  if (years.length < 2) seasonYear = years[0] || SEASON_ALL;
  else if (seasonYear !== SEASON_ALL && years.indexOf(seasonYear) < 0) seasonYear = SEASON_ALL;
  renderSeasonView();
}

function closeSeasonModal() {
  hideSeasonMenu();
  closeSeasonShareMenu();
  seasonOpenSeq++;
  document.getElementById('seasonModal').classList.remove('open');
  if (seasonChart) { seasonChart.destroy(); seasonChart = null; }
}

// Newest season first.
function seasonYears() {
  const set = new Set((seasonAllEntries || []).map(e => new Date(e.exitMs).getUTCFullYear()));
  return Array.from(set).sort((a, b) => b - a);
}

// The selected tab's name: the year, or "All seasons".
function seasonTabLabel() {
  return seasonYear === SEASON_ALL ? t('season.all') : String(seasonYear);
}

function setSeasonYear(year) {
  seasonYear = year;
  renderSeasonView();
}

// Tabs, summary line, legend and graph. Re-run on a tab, language or theme
// change; reads only what openSeasonModal() cached.
function renderSeasonView() {
  if (!seasonAllEntries) return;
  const tabs = document.getElementById('seasonTabs');
  tabs.innerHTML = '';
  const years = seasonYears();
  // "All seasons" only earns a tab when there is more than one.
  const options = years.length > 1 ? years.concat([SEASON_ALL]) : years;
  options.forEach(y => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'compare-view-tab' + (y === seasonYear ? ' active' : '');
    b.textContent = y === SEASON_ALL ? t('season.all') : String(y);
    b.addEventListener('click', () => setSeasonYear(y));
    tabs.appendChild(b);
  });

  const inTab = seasonAllEntries.filter(e =>
    seasonYear === SEASON_ALL || new Date(e.exitMs).getUTCFullYear() === seasonYear);
  // Every scored jump is plotted, however slow: the "Under 350 km/h" legend
  // toggle is how slow runs are switched off. Unscored jumps are left out
  // without a mention.
  const scored = inTab.filter(e => e.score !== null);
  const hiddenMap = getSeasonHidden();
  const hiddenInTab = scored.filter(e => hiddenMap[e.name]);
  const shown = scored.filter(e => !hiddenMap[e.name]);
  // Dot types switched off in the legend drop out like hidden jumps do.
  const off = getSeasonLegendOff();
  seasonKindsPresent = new Set(shown.map(seasonDotKind));
  seasonEntries = shown.filter(e => !off.has(seasonDotKind(e)));

  document.getElementById('seasonSummary').textContent = t('season.summary', { count: seasonEntries.length });
  // Nothing to share without a graph.
  document.getElementById('seasonShareWrap').hidden = !seasonEntries.length;
  if (!seasonEntries.length) closeSeasonShareMenu();

  // "Hidden: 2 · Show all", for the jumps in this tab only.
  const hiddenBox = document.getElementById('seasonHidden');
  hiddenBox.innerHTML = '';
  hiddenBox.hidden = !hiddenInTab.length;
  if (hiddenInTab.length) {
    hiddenBox.appendChild(document.createTextNode(t('season.hidden', { count: hiddenInTab.length }) + ' · '));
    const showAll = document.createElement('button');
    showAll.type = 'button';
    showAll.className = 'season-show-all';
    showAll.textContent = t('season.showAll');
    showAll.addEventListener('click', () => {
      setSeasonHidden(hiddenInTab.map(e => e.name), false);
      renderSeasonView();
    });
    hiddenBox.appendChild(showAll);
  }

  // The empty note is for a tab with no jumps at all, not one where every dot
  // type is switched off: the legend stays up so they can be switched back.
  const empty = document.getElementById('seasonEmpty');
  empty.hidden = seasonKindsPresent.size > 0;
  renderSeasonLegend();
  renderSeasonChart();
}

function seasonBest() {
  return seasonEntries.reduce((b, e) => (!b || e.score > b.score ? e : b), null);
}

// Below this many jumps a trend line says nothing.
const SEASON_TREND_MIN_JUMPS = 3;

// Where each jump sits on the x axis. One season: the jump number in date
// order. All seasons: every year gets the same width (year k runs from k to
// k + 1) and its jumps are spread evenly across it, so a busy year doesn't
// squeeze the others.
function seasonXPositions(entries) {
  if (seasonYear !== SEASON_ALL) return entries.map((e, i) => i);
  const yearOf = e => new Date(e.exitMs).getUTCFullYear();
  const counts = new Map();
  entries.forEach(e => counts.set(yearOf(e), (counts.get(yearOf(e)) || 0) + 1));
  const years = Array.from(counts.keys());
  const seen = new Map();
  return entries.map(e => {
    const y = yearOf(e);
    const k = seen.get(y) || 0;
    seen.set(y, k + 1);
    return years.indexOf(y) + (k + 0.5) / counts.get(y);
  });
}

// How closely the trend follows the dots: the width of its Gaussian kernel as
// a fraction of the plotted x range. Smaller bends more; large tends to a
// straight line.
const SEASON_TREND_BANDWIDTH = 0.09;
// ...but never narrower than this many average gaps between jumps, or with
// few jumps the curve runs through every dot and says nothing.
const SEASON_TREND_MIN_GAPS = 1.5;
const SEASON_TREND_STEPS = 120;

// A smoothed curve through the scores against their position on the graph
// (seasonXPositions(), as plotted), so it matches what the eye sees: a local
// linear regression with Gaussian weights, evaluated at SEASON_TREND_STEPS + 1
// points from the first jump to the last. Local linear rather than a plain
// weighted average, so the ends don't flatten towards the middle.
// Returns [{ x, y }] or null.
function seasonTrend() {
  const n = seasonEntries.length;
  if (n < SEASON_TREND_MIN_JUMPS) return null;
  const xs = seasonXPositions(seasonEntries);
  const x0 = xs[0], x1 = xs[n - 1];
  const range = x1 - x0;
  const h = Math.max(range * SEASON_TREND_BANDWIDTH, range / (n - 1) * SEASON_TREND_MIN_GAPS, 1e-6);
  const points = [];
  for (let s = 0; s <= SEASON_TREND_STEPS; s++) {
    const x = x0 + (x1 - x0) * s / SEASON_TREND_STEPS;
    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
    seasonEntries.forEach((e, i) => {
      const d = xs[i] - x;
      const w = Math.exp(-0.5 * (d / h) * (d / h));
      sw += w; swx += w * d; swy += w * e.score; swxx += w * d * d; swxy += w * d * e.score;
    });
    // Centred on x, the fit's value at x is its intercept. With every weight
    // on one side or one spot, the slope is undefined: use the weighted mean.
    const den = sw * swxx - swx * swx;
    const y = den > 1e-9 * sw * sw ? (swxx * swy - swx * swxy) / den : swy / sw;
    points.push({ x, y });
  }
  return points;
}

// The legend's items, in order: { key, kind ('dot', 'line' or 'dash'),
// color, text, off }. Only the types present in the tab get one. Shared by
// the legend and the shared image (share.js).
function seasonLegendItems() {
  const best = seasonBest();
  const off = getSeasonLegendOff();
  const accent = getThemeColor('accent') || '#38bdf8';
  const items = [];
  const item = (key, kind, color, text) => items.push({ key, kind, color, text, off: off.has(key) });
  if (seasonKindsPresent.has('jump')) item('jump', 'dot', accent, t('season.legendJump'));
  if (seasonKindsPresent.has('invalid')) item('invalid', 'dot', SEASON_INVALID_COLOR, t('season.legendInvalid'));
  if (seasonKindsPresent.has('slow')) item('slow', 'dot', SEASON_SLOW_COLOR, t('season.legendSlow', { max: SEASON_SLOW_KMH }));
  if (seasonTrend()) item('trend', 'line', accent, t('season.legendTrend'));
  if (best) item('pb', 'dash', '#94a3b8', t('season.legendPb', { score: best.score.toFixed(2) }));
  return items;
}

// Each legend item is a toggle that switches its dot type or line off and on.
// Switched-off ones stay in the legend, struck through, so they can be
// switched back.
function renderSeasonLegend() {
  const legend = document.getElementById('seasonLegend');
  legend.innerHTML = '';
  seasonLegendItems().forEach(it => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'season-legend-item ' + it.kind + (it.off ? ' off' : '');
    b.setAttribute('aria-pressed', it.off ? 'false' : 'true');
    b.style.setProperty('--sw', it.color);
    b.dataset.tip = t(it.off ? 'season.legendShowTip' : 'season.legendHideTip');
    // The swatch is a child span, not ::before, which the tooltip's arrow uses.
    const sw = document.createElement('span');
    sw.className = 'season-legend-swatch';
    b.append(sw, it.text);
    b.addEventListener('click', () => toggleSeasonLegend(it.key));
    legend.appendChild(b);
  });
}

// "14-09" for the day ticks of a single season (All seasons labels years).
function seasonDayLabel(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + '-' + p(d.getUTCMonth() + 1);
}

function renderSeasonChart() {
  if (seasonChart) { seasonChart.destroy(); seasonChart = null; }
  if (!seasonEntries.length) return;
  const canvas = document.getElementById('seasonChart');

  const accent = getThemeColor('accent') || '#38bdf8';
  const themeBgCard = getThemeColor('bg-card') || '#1e293b';
  const themeBorder = getThemeColor('border') || '#334155';
  const themeText = getThemeColor('text') || '#cbd5e1';
  const themeTextStrong = getThemeColor('text-strong') || '#f8fafc';
  const themeTextMuted = getThemeColor('text-muted') || '#94a3b8';
  const themeTextDim = getThemeColor('text-dim') || '#64748b';
  const off = getSeasonLegendOff();

  const entries = seasonEntries;
  const best = seasonBest();
  const allSeasons = seasonYear === SEASON_ALL;
  // Jumps are spaced evenly in date order rather than on a time axis: a season
  // has long gaps between days and dense clusters within them, and a time axis
  // would stack each day's jumps into one blob. A tick marks each new day.
  const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
  const dayStarts = [];
  entries.forEach((e, i) => { if (i === 0 || dayKey(e.exitMs) !== dayKey(entries[i - 1].exitMs)) dayStarts.push(i); });
  // All seasons: a tick per day across years is unreadable, so the axis gets
  // one label per year, centred under that year, and a vertical line between
  // years instead. Every year is the same width (seasonXPositions()).
  const yearOf = e => new Date(e.exitMs).getUTCFullYear();
  const yearStarts = [];
  entries.forEach((e, i) => { if (i === 0 || yearOf(e) !== yearOf(entries[i - 1])) yearStarts.push(i); });
  const xs = seasonXPositions(entries);
  const xTicks = new Map();   // tick value -> label
  if (allSeasons) {
    yearStarts.forEach((start, k) => xTicks.set(k + 0.5, String(yearOf(entries[start]))));
  } else {
    dayStarts.forEach(i => xTicks.set(i, seasonDayLabel(entries[i].exitMs)));
  }
  const kindColor = { jump: accent, invalid: SEASON_INVALID_COLOR, slow: SEASON_SLOW_COLOR };
  const pointColors = entries.map(e => kindColor[seasonDotKind(e)]);
  const trend = seasonTrend();
  // Both lines sit under the dots. The personal best is an annotation and the
  // trend is drawn by a plugin, not as datasets: they must never take a dot's
  // hover or click.
  const annotations = {};
  if (allSeasons) {
    yearStarts.slice(1).forEach((start, k) => {
      annotations['year' + (k + 1)] = {
        type: 'line',
        drawTime: 'beforeDatasetsDraw',
        xMin: k + 1,
        xMax: k + 1,
        borderColor: hexToRgba(themeTextMuted, 0.45),
        borderWidth: 1
      };
    });
  }
  if (!off.has('pb')) {
    annotations.personalBest = {
      type: 'line',
      drawTime: 'beforeDatasetsDraw',
      yMin: best.score,
      yMax: best.score,
      borderColor: '#94a3b8',
      borderWidth: 1.5,
      borderDash: [6, 5]
    };
  }
  // The trend is a curve, which an annotation line can't draw.
  const trendCurve = {
    id: 'seasonTrendCurve',
    beforeDatasetsDraw(chart) {
      if (!trend || off.has('trend')) return;
      const { ctx, chartArea, scales } = chart;
      ctx.save();
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top, chartArea.width, chartArea.height);
      ctx.clip();
      ctx.beginPath();
      trend.forEach((p, i) => {
        const px = scales.x.getPixelForValue(p.x), py = scales.y.getPixelForValue(p.y);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.strokeStyle = hexToRgba(accent, 0.75);
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }
  };

  seasonChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    plugins: [trendCurve],
    data: {
      datasets: [
        {
          label: t('season.legendJump'),
          data: entries.map((e, i) => ({ x: xs[i], y: e.score })),
          // A faint line joins the dots in date order, so the run of the
          // season reads at a glance without competing with the dots.
          showLine: true,
          borderColor: hexToRgba(themeTextMuted, 0.3),
          borderWidth: 1,
          tension: 0,
          pointRadius: 4.5,
          pointHoverRadius: 7,
          pointHitRadius: 8,
          pointBackgroundColor: pointColors,
          pointBorderColor: themeBgCard,
          pointBorderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', intersect: false },
      onHover: (evt, active) => { canvas.style.cursor = active.length ? 'pointer' : 'default'; },
      onClick: (evt, active) => {
        // The tap that ends a long press must not also open the jump.
        if (seasonSuppressClick) { seasonSuppressClick = false; return; }
        if (!active.length) return;
        const name = entries[active[0].index].name;
        closeSeasonModal();
        openJumpFromElsewhere(name);
      },
      plugins: {
        legend: { display: false },
        // The personal best is an annotation rather than a dataset, so it can
        // never be the "nearest" element and steal a hover or a click from a
        // dot it runs through.
        annotation: { annotations },
        tooltip: {
          animation: false,
          backgroundColor: themeBgCard,
          titleColor: themeTextStrong,
          bodyColor: themeText,
          borderColor: themeBorder,
          borderWidth: 1,
          // Solid dot in the jump's colour, matching the main chart.
          usePointStyle: true,
          boxWidth: 11,
          boxHeight: 11,
          callbacks: {
            labelPointStyle: () => ({ pointStyle: 'circle', rotation: 0 }),
            labelColor: ctx => {
              const c = pointColors[ctx.dataIndex];
              return { backgroundColor: c, borderColor: c, borderWidth: 0 };
            },
            title: items => {
              if (!items.length) return '';
              const e = entries[items[0].dataIndex];
              return e.name + '  ·  ' + formatJumpDayHeader(new Date(e.exitMs));
            },
            label: ctx => {
              const e = entries[ctx.dataIndex];
              const lines = [' ' + e.score.toFixed(2) + ' km/h',
                ' ' + t('season.tipExit', { m: Math.round(e.exitAglM), ft: Math.round(e.exitAglM / 0.3048).toLocaleString('en-US') })];
              if (!e.exitValid) lines.push(' ' + t('season.legendInvalid'));
              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: allSeasons ? 0 : -0.5,
          max: allSeasons ? yearStarts.length : entries.length - 0.5,
          afterBuildTicks: axis => { axis.ticks = Array.from(xTicks.keys(), v => ({ value: v })); },
          ticks: {
            color: allSeasons ? themeTextMuted : themeTextDim,
            maxRotation: 0,
            autoSkip: true,
            callback: v => xTicks.get(v) || ''
          },
          // On All seasons the ticks sit mid-year, so their grid lines would
          // mean nothing: the year lines are annotations instead.
          grid: { color: 'rgba(148,163,184,0.08)', display: !allSeasons }
        },
        y: {
          type: 'linear',
          grace: '5%',
          title: { display: true, text: t('season.axisScore'), color: themeTextMuted },
          ticks: { color: themeTextDim },
          grid: { color: 'rgba(148,163,184,0.08)' }
        }
      }
    }
  });
  // Opening the modal renders in the same task that reveals it; same guard as
  // the compare graphs.
  setTimeout(() => { if (seasonChart) seasonChart.resize(); }, 0);
}

// ── Dot menu: right-click (or long press on touch) ──
// "Open jump" and "Hide from season". Same look and dismiss behaviour as the
// main chart's exit menu (.chart-context-menu). Wired once: the canvas stays,
// only the chart on it is rebuilt.
const SEASON_LONG_PRESS_MS = 500;
let seasonMenu = null;
let seasonSuppressClick = false;

function hideSeasonMenu() {
  if (seasonMenu) { seasonMenu.remove(); seasonMenu = null; }
  document.removeEventListener('click', hideSeasonMenu, true);
  document.removeEventListener('scroll', hideSeasonMenu, true);
}

// The entry under the event, or null when it is not on a dot.
function seasonEntryAt(evt) {
  if (!seasonChart) return null;
  const hit = seasonChart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, false);
  return hit.length ? seasonEntries[hit[0].index] || null : null;
}

function showSeasonMenu(entry, clientX, clientY) {
  hideSeasonMenu();
  seasonMenu = document.createElement('div');
  seasonMenu.className = 'chart-context-menu';
  const item = (key, onPick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chart-context-item';
    b.textContent = t(key);
    b.addEventListener('click', () => { hideSeasonMenu(); onPick(); });
    seasonMenu.appendChild(b);
  };
  item('season.ctxOpen', () => { closeSeasonModal(); openJumpFromElsewhere(entry.name); });
  item('season.ctxHide', () => { setSeasonHidden([entry.name], true); renderSeasonView(); });

  seasonMenu.style.left = clientX + 'px';
  seasonMenu.style.top = clientY + 'px';
  document.body.appendChild(seasonMenu);
  const rect = seasonMenu.getBoundingClientRect();
  if (rect.right > window.innerWidth) seasonMenu.style.left = (clientX - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) seasonMenu.style.top = (clientY - rect.height) + 'px';
  setTimeout(() => {
    document.addEventListener('click', hideSeasonMenu, true);
    document.addEventListener('scroll', hideSeasonMenu, true);
  }, 0);
}

(function initSeasonMenu() {
  const canvas = document.getElementById('seasonChart');
  if (!canvas) return;
  // Off a dot, the browser's own menu shows as usual.
  canvas.addEventListener('contextmenu', e => {
    const entry = seasonEntryAt(e);
    if (!entry) return;
    e.preventDefault();
    showSeasonMenu(entry, e.clientX, e.clientY);
  });

  let pressTimer = null;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  canvas.addEventListener('touchstart', e => {
    cancelPress();
    seasonSuppressClick = false;
    if (e.touches.length !== 1) return;
    const entry = seasonEntryAt(e);
    if (!entry) return;
    const { clientX, clientY } = e.touches[0];
    pressTimer = setTimeout(() => {
      pressTimer = null;
      seasonSuppressClick = true;
      showSeasonMenu(entry, clientX, clientY);
    }, SEASON_LONG_PRESS_MS);
  }, { passive: true });
  canvas.addEventListener('touchmove', cancelPress, { passive: true });
  canvas.addEventListener('touchend', cancelPress);
  canvas.addEventListener('touchcancel', cancelPress);
})();

// Escape closes the dot menu or the share menu first, then the modal
// (backdrop clicks are ignored, matching the other modals).
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (seasonMenu) { hideSeasonMenu(); return; }
  if (!document.getElementById('seasonShareMenu').hidden) { closeSeasonShareMenu(); return; }
  if (document.getElementById('seasonModal').classList.contains('open')) closeSeasonModal();
});
