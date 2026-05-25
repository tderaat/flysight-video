// ── Theme switching ──
// Stores the selected theme in a cookie (`theme=...`). Falls back to
// localStorage for environments where cookies don't persist
// (notably Chrome / Edge under file:// origins).
//
// The early-apply step that sets `data-theme` on <html> before paint
// lives inline in index.html's <head>. This file wires up the dropdown
// and triggers a chart/map re-render when the user switches themes.

var THEMES = ['dark-blue', 'light', 'dark-red', 'dark-green'];
var DEFAULT_THEME = 'dark-blue';

function setThemeCookie(value) {
  try {
    var d = new Date();
    d.setTime(d.getTime() + 365 * 24 * 60 * 60 * 1000);
    document.cookie = 'theme=' + encodeURIComponent(value) +
      ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  } catch (e) {}
}

function getThemeCookie() {
  try {
    var m = document.cookie.match(/(?:^|;\s*)theme=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch (e) { return null; }
}

function readStoredTheme() {
  var t = getThemeCookie();
  if (!t || THEMES.indexOf(t) < 0) {
    try { t = localStorage.getItem('theme'); } catch (e) { t = null; }
  }
  return THEMES.indexOf(t) >= 0 ? t : DEFAULT_THEME;
}

function writeStoredTheme(t) {
  setThemeCookie(t);
  // Mirror to localStorage so themes still persist under file:// in
  // browsers that drop cookies on local files.
  try { localStorage.setItem('theme', t); } catch (e) {}
}

function applyTheme(t) {
  if (THEMES.indexOf(t) < 0) t = DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', t);
  // Re-render the chart + map so JS-side theme colors update too.
  if (typeof renderCurrentJump === 'function' &&
      typeof state !== 'undefined' && state.currentJumpName) {
    try { renderCurrentJump(); } catch (e) {}
  }
}

// Reads a CSS custom property from <html>. Returned strings are
// trimmed and may be empty if the variable isn't defined.
function getThemeColor(name) {
  var v = getComputedStyle(document.documentElement)
    .getPropertyValue('--' + name);
  return v ? v.trim() : '';
}

// Compose an rgba() from a hex color + alpha. Used for chart fills
// where we want a translucent tint of the active accent.
function hexToRgba(hex, alpha) {
  if (!hex) return 'rgba(0,0,0,' + alpha + ')';
  hex = hex.trim().replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  var r = parseInt(hex.slice(0, 2), 16);
  var g = parseInt(hex.slice(2, 4), 16);
  var b = parseInt(hex.slice(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

document.addEventListener('DOMContentLoaded', function() {
  var sel = document.getElementById('themeSelect');
  if (!sel) return;
  sel.value = readStoredTheme();
  sel.addEventListener('change', function() {
    var t = sel.value;
    writeStoredTheme(t);
    applyTheme(t);
  });
});
