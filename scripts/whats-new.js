// ── What's new callouts ──
// A one-off callout pointing at a newly added control, shown to *returning*
// users only. A first-time visitor sees nothing: everything is new to them, and
// a stack of popups on the first load would bury the app.
//
// Who counts as returning is decided by the date this browser first opened the
// app (`flysight_first_seen`, YYYY-MM-DD, written once). An entry is shown when
// it was added after that date, is no older than WHATS_NEW_MAX_AGE_DAYS, and its
// id is not yet in `flysight_whats_new_seen` (dismissed or clicked). Storing the
// first visit rather than the last one means a user who closes the tab before
// the callout appears still gets it next time.
//
// To announce a feature, add one entry below plus its text key in every
// language in translations.js. Nothing else changes.
//   id:     stable key recorded once the callout is dismissed
//   added:  release date, YYYY-MM-DD
//   target: CSS selector of the control the arrow points at
//   text:   translation key for the one-line explanation
var WHATS_NEW = [
  { id: 'feedback', added: '2026-10-27', target: '#feedbackBtn', text: 'new.feedback' },
  { id: 'season', added: '2026-10-27', target: '#seasonBtn', text: 'new.season' },
];

var WHATS_NEW_FIRST_SEEN_KEY = 'flysight_first_seen';
var WHATS_NEW_SEEN_KEY = 'flysight_whats_new_seen';
var WHATS_NEW_MAX_AGE_DAYS = 60;
var WHATS_NEW_SHOW_DELAY_MS = 1500;
var WHATS_NEW_NEXT_DELAY_MS = 600;
// First-seen date given to a browser that predates this feature but clearly
// used the app before (see whatsNewHasPriorUse), so it counts as returning.
var WHATS_NEW_LEGACY_FIRST_SEEN = '2000-01-01';
// localStorage keys only ever written by someone using the app: any of them
// present means this browser has been here before.
var WHATS_NEW_PRIOR_USE_KEYS = [
  'flysight_scores', 'flysight_last_jump', 'flysight_chart_series',
  'flysight_exit_overrides', 'flysight_jump_sort', 'flysight_notes', 'theme', 'lang',
];

var whatsNewQueue = [];
var whatsNewActive = null;   // { item, target, el, onTargetClick, resizeObserver }
var whatsNewWaitObserver = null;

// Same cookie + localStorage mirror as the theme and sort preferences, so the
// first-seen date survives file:// origins that drop cookies.
function readWhatsNewPref(key) {
  var v = null;
  try {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + key + '=([^;]+)'));
    if (m) v = decodeURIComponent(m[1]);
  } catch (e) {}
  if (v == null) { try { v = localStorage.getItem(key); } catch (e) {} }
  return v;
}

function writeWhatsNewPref(key, value) {
  try {
    var d = new Date();
    d.setTime(d.getTime() + 365 * 24 * 60 * 60 * 1000);
    document.cookie = key + '=' + encodeURIComponent(value) +
      ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  } catch (e) {}
  try { localStorage.setItem(key, value); } catch (e) {}
}

function getWhatsNewSeen() {
  try {
    var arr = JSON.parse(readWhatsNewPref(WHATS_NEW_SEEN_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function markWhatsNewSeen(id) {
  var seen = getWhatsNewSeen();
  if (seen.indexOf(id) < 0) seen.push(id);
  writeWhatsNewPref(WHATS_NEW_SEEN_KEY, JSON.stringify(seen));
}

function whatsNewToday() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

async function whatsNewHasPriorUse() {
  try {
    if (localStorage.getItem('flysight_has_jumps') === '1') return true;
    for (var i = 0; i < WHATS_NEW_PRIOR_USE_KEYS.length; i++) {
      if (localStorage.getItem(WHATS_NEW_PRIOR_USE_KEYS[i]) != null) return true;
    }
  } catch (e) {}
  try { return (await getJumpIndex()).length > 0; } catch (e) { return false; }
}

// Returns this browser's first-seen date, writing it on the very first call.
async function ensureWhatsNewFirstSeen() {
  var v = readWhatsNewPref(WHATS_NEW_FIRST_SEEN_KEY);
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  v = (await whatsNewHasPriorUse()) ? WHATS_NEW_LEGACY_FIRST_SEEN : whatsNewToday();
  writeWhatsNewPref(WHATS_NEW_FIRST_SEEN_KEY, v);
  return v;
}

function pendingWhatsNew(firstSeen) {
  var seen = getWhatsNewSeen();
  var cutoff = new Date(Date.now() - WHATS_NEW_MAX_AGE_DAYS * 86400000);
  return WHATS_NEW.filter(function (item) {
    return item.added > firstSeen &&
      new Date(item.added + 'T00:00:00') >= cutoff &&
      seen.indexOf(item.id) < 0;
  });
}

function whatsNewTargetVisible(target) {
  return !!target && target.getClientRects().length > 0;
}

function whatsNewModalOpen() {
  return !!document.querySelector('.modal-backdrop.open');
}

// Show the head of the queue. A target that isn't on screen yet (e.g. a button
// that only appears once a jump is loaded) or an open modal parks the queue
// until <body>'s class or a modal's class changes, then tries again.
function showNextWhatsNew() {
  if (whatsNewActive || !whatsNewQueue.length) return;
  var item = whatsNewQueue[0];
  var target = document.querySelector(item.target);
  if (!whatsNewTargetVisible(target) || whatsNewModalOpen()) {
    waitForWhatsNewTarget();
    return;
  }
  stopWaitingForWhatsNewTarget();

  var el = document.createElement('div');
  el.className = 'whats-new';
  el.setAttribute('role', 'dialog');
  el.innerHTML =
    '<span class="whats-new-arrow" aria-hidden="true"></span>' +
    '<div class="whats-new-head">' +
      '<span class="whats-new-label"></span>' +
      '<button type="button" class="whats-new-close">&times;</button>' +
    '</div>' +
    '<div class="whats-new-text"></div>' +
    '<button type="button" class="whats-new-ok"></button>';
  el.querySelector('.whats-new-close').addEventListener('click', dismissWhatsNew);
  el.querySelector('.whats-new-ok').addEventListener('click', dismissWhatsNew);
  document.body.appendChild(el);

  // Using the control is as good as acknowledging the callout.
  var onTargetClick = function () { dismissWhatsNew(); };
  target.addEventListener('click', onTargetClick);

  // The target can move without the window resizing: the top bar is anchored
  // right, so the Compare and Video buttons appearing on a jump load push
  // Feedback left. Re-aim whenever the target, its row or the page changes size.
  var resizeObserver = new ResizeObserver(positionWhatsNew);
  [target, target.parentElement, document.documentElement].forEach(function (n) {
    if (n) resizeObserver.observe(n);
  });

  whatsNewActive = {
    item: item, target: target, el: el,
    onTargetClick: onTargetClick, resizeObserver: resizeObserver,
  };
  fillWhatsNewText();
  positionWhatsNew();
}

function waitForWhatsNewTarget() {
  if (whatsNewWaitObserver) return;
  whatsNewWaitObserver = new MutationObserver(function () {
    // Defer one frame so the class change has been laid out.
    requestAnimationFrame(showNextWhatsNew);
  });
  whatsNewWaitObserver.observe(document.body, {
    attributes: true, attributeFilter: ['class'], subtree: true,
  });
}

function stopWaitingForWhatsNewTarget() {
  if (!whatsNewWaitObserver) return;
  whatsNewWaitObserver.disconnect();
  whatsNewWaitObserver = null;
}

function fillWhatsNewText() {
  if (!whatsNewActive) return;
  var el = whatsNewActive.el;
  el.setAttribute('aria-label', t('new.label'));
  el.querySelector('.whats-new-label').textContent = t('new.label');
  el.querySelector('.whats-new-text').textContent = t(whatsNewActive.item.text);
  el.querySelector('.whats-new-ok').textContent = t('new.gotIt');
  el.querySelector('.whats-new-close').setAttribute('aria-label', t('new.dismiss'));
}

// Re-translate an open callout on a live language switch (called from
// applyLanguage()). The text length changes, so the arrow is re-aimed too.
function refreshWhatsNewLang() {
  fillWhatsNewText();
  positionWhatsNew();
}

// Place the callout under its target with the arrow on the target's centre,
// clamped to a 16 px gutter so it never overflows a narrow screen. Coordinates
// are relative to the callout's offset parent, so it scrolls with the page just
// like the absolute top bar it points into.
function positionWhatsNew() {
  if (!whatsNewActive) return;
  var a = whatsNewActive;
  if (!whatsNewTargetVisible(a.target)) { a.el.hidden = true; return; }
  a.el.hidden = false;
  var r = a.target.getBoundingClientRect();
  var base = (a.el.offsetParent || document.documentElement).getBoundingClientRect();
  var w = a.el.offsetWidth;
  var vw = document.documentElement.clientWidth;
  var center = r.left + r.width / 2;
  var left = Math.max(16, Math.min(center - w / 2, vw - 16 - w));
  a.el.style.left = (left - base.left) + 'px';
  a.el.style.top = (r.bottom - base.top + 12) + 'px';
  var arrowX = Math.max(14, Math.min(center - left, w - 14));
  a.el.querySelector('.whats-new-arrow').style.left = arrowX + 'px';
}

function dismissWhatsNew() {
  if (!whatsNewActive) return;
  var a = whatsNewActive;
  markWhatsNewSeen(a.item.id);
  a.target.removeEventListener('click', a.onTargetClick);
  a.resizeObserver.disconnect();
  a.el.remove();
  whatsNewActive = null;
  whatsNewQueue.shift();
  if (whatsNewQueue.length) setTimeout(showNextWhatsNew, WHATS_NEW_NEXT_DELAY_MS);
}

document.addEventListener('keydown', function (e) {
  // Escape belongs to an open modal first; only take it when none is open.
  if (e.key === 'Escape' && whatsNewActive && !whatsNewModalOpen()) dismissWhatsNew();
});

(async function initWhatsNew() {
  var firstSeen = await ensureWhatsNewFirstSeen();
  whatsNewQueue = pendingWhatsNew(firstSeen);
  if (whatsNewQueue.length) setTimeout(showNextWhatsNew, WHATS_NEW_SHOW_DELAY_MS);
})();
