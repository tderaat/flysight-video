// ── Internationalization (i18n) ──
// Mirrors the theme-switching pattern in scripts/theme.js: the chosen language
// is stored in a cookie (`lang=...`) with a localStorage fallback (cookies are
// dropped on file:// origins in some browsers). On first visit (no stored
// preference) the language is auto-detected from navigator.language.
//
// Translation data lives in scripts/translations.js (global `I18N`). This file
// is the engine: t() for lookups, applyTranslations() for static DOM, and
// applyLanguage() which re-renders the JS-built UI so a live switch updates
// everything without a reload.
//
// The on-canvas video-overlay widget labels are intentionally NOT translated
// (see translations.js) — exported video looks the same in every language.

var LANGUAGES = ['en', 'de', 'nl', 'it'];
var DEFAULT_LANG = 'en';

function setLangCookie(value) {
  try {
    var d = new Date();
    d.setTime(d.getTime() + 365 * 24 * 60 * 60 * 1000);
    document.cookie = 'lang=' + encodeURIComponent(value) +
      ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  } catch (e) {}
}

function getLangCookie() {
  try {
    var m = document.cookie.match(/(?:^|;\s*)lang=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch (e) { return null; }
}

// Best-effort match of the browser's preferred language to one we support
// (compares the primary subtag, e.g. "de-AT" -> "de"). Used only on first
// visit when nothing is stored.
function detectBrowserLang() {
  try {
    var list = navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language || ''];
    for (var i = 0; i < list.length; i++) {
      var code = (list[i] || '').toLowerCase().split('-')[0];
      if (LANGUAGES.indexOf(code) >= 0) return code;
    }
  } catch (e) {}
  return DEFAULT_LANG;
}

function readStoredLang() {
  var l = getLangCookie();
  if (!l || LANGUAGES.indexOf(l) < 0) {
    try { l = localStorage.getItem('lang'); } catch (e) { l = null; }
  }
  if (LANGUAGES.indexOf(l) >= 0) return l;
  return detectBrowserLang();
}

function writeStoredLang(l) {
  setLangCookie(l);
  // Mirror to localStorage so the choice persists under file:// in browsers
  // that drop cookies on local files.
  try { localStorage.setItem('lang', l); } catch (e) {}
}

// Active language, resolved at parse time so t() works for any render code that
// runs during script load (before DOMContentLoaded).
var currentLang = readStoredLang();

// Translate a key for the active language. Falls back to English, then to the
// raw key (so a missing translation degrades visibly but never throws).
// `params` substitutes {token} placeholders.
function t(key, params) {
  var table = (typeof I18N !== 'undefined' && I18N[currentLang]) || {};
  var en = (typeof I18N !== 'undefined' && I18N[DEFAULT_LANG]) || {};
  var s = table[key];
  if (s == null) s = en[key];
  if (s == null) s = key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, function(m, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? params[name] : m;
    });
  }
  return s;
}

// Fill static markup. Elements opt in via data-i18n* attributes:
//   data-i18n       -> textContent
//   data-i18n-tip   -> data-tip attribute (styled hover tooltip)
//   data-i18n-ph    -> placeholder
//   data-i18n-aria  -> aria-label
function applyTranslations(root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-tip]').forEach(function(el) {
    el.setAttribute('data-tip', t(el.getAttribute('data-i18n-tip')));
  });
  root.querySelectorAll('[data-i18n-ph]').forEach(function(el) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
  });
  root.querySelectorAll('[data-i18n-aria]').forEach(function(el) {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });
}

// Switch language: update the active code, re-fill static markup, then re-run
// the JS-built render paths so dynamic content (chips, stats, chart, map,
// compare modal, widget config) repaints in the new language. Guarded with
// typeof checks, mirroring applyTheme's defensive style.
function applyLanguage(lang) {
  if (LANGUAGES.indexOf(lang) < 0) lang = DEFAULT_LANG;
  currentLang = lang;
  document.documentElement.lang = lang;
  applyTranslations(document);

  if (typeof renderJumpList === 'function') {
    try { renderJumpList(); } catch (e) {}
  }
  if (typeof renderCurrentJump === 'function' &&
      typeof state !== 'undefined' && state.currentJumpName) {
    try { renderCurrentJump(state.chartShowFull); } catch (e) {}
  }
  // Compare modal: refresh list + active view if it's open.
  if (typeof state !== 'undefined' &&
      document.getElementById('compareModal') &&
      document.getElementById('compareModal').classList.contains('open')) {
    if (typeof renderCompareJumpsList === 'function') { try { renderCompareJumpsList(); } catch (e) {} }
    if (typeof renderCompareView === 'function') { try { renderCompareView(); } catch (e) {} }
    if (typeof syncCompareClipButton === 'function') { try { syncCompareClipButton(); } catch (e) {} }
  }
  // Video modal: dynamic, JS-driven text not covered by data-i18n.
  refreshVideoModalLang();
  // Selected widget's config panel (rebuilt from scratch in the new language).
  if (typeof updateWidgetSettingsPanel === 'function') {
    try { updateWidgetSettingsPanel(); } catch (e) {}
  }
}

// Re-apply the JS-set bits of the video modal (play/pause button + "Not set"
// exit timecode) so a mid-session language switch updates them too.
function refreshVideoModalLang() {
  var playBtn = document.getElementById('videoPlayBtn');
  var video = document.getElementById('videoPreview');
  if (playBtn && video) {
    playBtn.textContent = video.paused ? t('video.play') : t('video.pause');
  }
  var exitTc = document.getElementById('videoExitTimecode');
  if (exitTc && typeof state !== 'undefined' && state.videoExitTime === null) {
    exitTc.textContent = t('video.notSet');
  }
}

document.addEventListener('DOMContentLoaded', function() {
  // Localize the static markup for the resolved language.
  applyTranslations(document);
  var sel = document.getElementById('langSelect');
  if (!sel) return;
  sel.value = currentLang;
  sel.addEventListener('change', function() {
    var l = sel.value;
    writeStoredLang(l);
    applyLanguage(l);
  });
});
