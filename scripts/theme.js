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

// ── Circle picker UI (shared by the theme + language dropdowns) ──
// Each picker is a round button (`.picker-btn`) that toggles a `.picker-menu`.
// These helpers are global so scripts/i18n.js can reuse them for the language
// picker (theme.js loads first).
function closeAllPickers(except) {
  document.querySelectorAll('.picker.open').forEach(function(p) {
    if (p === except) return;
    p.classList.remove('open');
    var b = p.querySelector('.picker-btn');
    if (b) b.setAttribute('aria-expanded', 'false');
  });
}
function wirePickerButton(btn) {
  if (!btn) return;
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    var picker = btn.closest('.picker');
    var willOpen = !picker.classList.contains('open');
    closeAllPickers(picker);
    picker.classList.toggle('open', willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  });
}
document.addEventListener('click', function(e) {
  if (!e.target.closest('.picker')) closeAllPickers();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeAllPickers();
});

// Each theme's representative accent swatch (matches the CSS --accent per theme).
var THEME_META = [
  { value: 'dark-blue',  swatch: '#38bdf8', key: 'theme.darkBlue' },
  { value: 'light',      swatch: '#0284c7', key: 'theme.light' },
  { value: 'dark-red',   swatch: '#b91c1c', key: 'theme.darkRed' },
  { value: 'dark-green', swatch: '#22ee5e', key: 'theme.darkGreen' },
];

// (Re)build the theme dropdown — called on load and on language switch so the
// labels re-translate and the active row tracks the current theme.
function renderThemeMenu() {
  var menu = document.getElementById('themeMenu');
  if (!menu) return;
  var current = readStoredTheme();
  menu.innerHTML = '';
  THEME_META.forEach(function(m) {
    var opt = document.createElement('div');
    opt.className = 'picker-option' + (m.value === current ? ' active' : '');
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', String(m.value === current));
    var sw = document.createElement('span');
    sw.className = 'picker-swatch';
    sw.style.background = m.swatch;
    var label = document.createElement('span');
    label.textContent = (typeof t === 'function') ? t(m.key) : m.value;
    opt.appendChild(sw);
    opt.appendChild(label);
    opt.addEventListener('click', function() {
      writeStoredTheme(m.value);
      applyTheme(m.value);
      renderThemeMenu();
      closeAllPickers();
    });
    menu.appendChild(opt);
  });
}

document.addEventListener('DOMContentLoaded', function() {
  wirePickerButton(document.getElementById('themeBtn'));
  renderThemeMenu();
});
