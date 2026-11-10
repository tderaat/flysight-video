// ── Page layouts (top-bar layout picker) ──
// "scroll" is the original page: panels stacked in the main column, each with
// its own height handle, the page scrolling. The other layouts lock the page
// to the window: .page-layout becomes a 3-column, 2-row grid (areas per layout
// in style.css), and three splitters between the panels trade space between
// them. A locked layout only applies with a jump loaded and above the 900 px
// breakpoint; otherwise the page falls back to the scrolling one.
//
// The choice persists in a cookie mirrored to localStorage (same pattern as
// theme/lang); the splitter sizes per layout in localStorage, as fractions, so
// they survive a window resize or another monitor.

var LAYOUT_KEY = 'flysight_layout';
var LAYOUT_SIZES_KEY = 'flysight_layout_sizes';

// `r`: the menu thumbnail, rectangles in a 48 x 30 box ([x, y, w, h]).
// `cols` / `rows`: default track fractions. `col3`: the pane whose left edge
// is the second column boundary. `rowPanes`: the panes whose top edge is the
// row boundary. Together they place the splitters (placeLayoutSplits()).
var PAGE_LAYOUTS = [
  { id: 'scroll', key: 'layout.scroll',
    r: { jumps: [0, 0, 12, 30], graph: [14, 0, 32, 11], map: [14, 13, 23, 11], info: [39, 13, 7, 11], notes: [14, 26, 32, 4], scroll: [47, 0, 1, 14] } },
  { id: 'a', key: 'layout.classic', cols: [0.22, 0.58, 0.20], rows: [0.55, 0.45], col3: 'info', rowPanes: ['map', 'info'],
    r: { jumps: [0, 0, 12, 30], graph: [14, 0, 34, 14], map: [14, 16, 24, 14], info: [40, 16, 8, 14] } },
  { id: 'b', key: 'layout.rail', cols: [0.22, 0.58, 0.20], rows: [0.55, 0.45], col3: 'info', rowPanes: ['map'],
    r: { jumps: [0, 0, 12, 30], graph: [14, 0, 24, 14], map: [14, 16, 24, 14], info: [40, 0, 8, 30] } },
];
// Smallest pane, in px: the jump list column, the other two columns, a row.
var LAYOUT_MIN_JUMPS = 240, LAYOUT_MIN_COL = 220, LAYOUT_MIN_ROW = 160;

function readStoredLayout() {
  var v = null;
  try { var m = document.cookie.match(/(?:^|;\s*)flysight_layout=([^;]+)/); if (m) v = m[1]; } catch (e) {}
  if (v == null) { try { v = localStorage.getItem(LAYOUT_KEY); } catch (e) {} }
  return PAGE_LAYOUTS.some(function(l) { return l.id === v; }) ? v : 'scroll';
}
function writeStoredLayout(id) {
  try {
    var d = new Date();
    d.setTime(d.getTime() + 365 * 24 * 60 * 60 * 1000);
    document.cookie = LAYOUT_KEY + '=' + id + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  } catch (e) {}
  try { localStorage.setItem(LAYOUT_KEY, id); } catch (e) {}
}
function readLayoutSizes() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_SIZES_KEY)) || {}; } catch (e) { return {}; }
}
function layoutDef(id) {
  return PAGE_LAYOUTS.filter(function(l) { return l.id === id; })[0] || PAGE_LAYOUTS[0];
}
// The saved sizes of a layout, or its defaults.
function layoutSizes(id) {
  var def = layoutDef(id), s = readLayoutSizes()[id];
  var ok = s && Array.isArray(s.cols) && s.cols.length === 3 && Array.isArray(s.rows) && s.rows.length === 2;
  return { cols: (ok ? s.cols : def.cols).slice(), rows: (ok ? s.rows : def.rows).slice() };
}
function saveLayoutSizes(id, sizes) {
  var all = readLayoutSizes();
  if (sizes) all[id] = sizes; else delete all[id];
  try { localStorage.setItem(LAYOUT_SIZES_KEY, JSON.stringify(all)); } catch (e) {}
}

function layoutThumb(def, width) {
  var s = '<svg class="layout-thumb" width="' + width + '" height="' + (width * 30 / 48) +
    '" viewBox="0 0 48 30" aria-hidden="true">';
  Object.keys(def.r).forEach(function(k) {
    var q = def.r[k];
    s += '<rect class="t-' + k + '" x="' + q[0] + '" y="' + q[1] + '" width="' + q[2] + '" height="' + q[3] + '" rx="1.5"/>';
  });
  return s + '</svg>';
}

// (Re)build the menu and the button icon. Also called from applyLanguage().
function renderLayoutMenu() {
  var menu = document.getElementById('layoutMenu');
  var btn = document.getElementById('layoutBtn');
  if (!menu || !btn) return;
  var current = readStoredLayout();
  btn.innerHTML = layoutThumb(layoutDef(current), 20);
  menu.innerHTML = '';
  PAGE_LAYOUTS.forEach(function(l) {
    var opt = document.createElement('div');
    opt.className = 'picker-option layout-option' + (l.id === current ? ' active' : '');
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', String(l.id === current));
    opt.innerHTML = layoutThumb(l, 48) +
      '<span class="layout-option-text"><span></span><span class="layout-option-hint"></span></span>';
    opt.querySelector('.layout-option-text > span').textContent = t(l.key);
    opt.querySelector('.layout-option-hint').textContent = t(l.key + 'Hint');
    opt.addEventListener('click', function() {
      closeAllPickers();
      switchPageLayout(l.id);
    });
    menu.appendChild(opt);
  });
}

(function() {
  var page = document.querySelector('.page-layout');
  var sidebar = document.querySelector('.sidebar');
  var main = document.querySelector('.main-content');
  var notes = document.querySelector('.notes-panel');
  var statsPanel = document.querySelector('.stats-panel');
  var footer = document.querySelector('.page-footer');
  var mapEl = document.getElementById('map');
  if (!page || !sidebar || !main) return;
  var PANES = {
    jumps: sidebar,
    graph: document.querySelector('.chart-container'),
    map: document.querySelector('.map-container'),
    info: statsPanel,
  };
  var mq = window.matchMedia('(max-width: 900px)');
  var locked = false;
  var jumpShown = false;

  // Splitters: the boundary between columns 1|2 and 2|3, and the row boundary.
  var splits = {};
  ['col1', 'col2', 'row'].forEach(function(k) {
    var el = document.createElement('div');
    el.className = 'layout-split ' + (k === 'row' ? 'row' : 'col');
    el.setAttribute('data-tip', t('tip.layoutSplit'));
    el.setAttribute('data-i18n-tip', 'tip.layoutSplit');
    page.appendChild(el);
    splits[k] = el;
  });

  function current() { return document.body.dataset.layout; }

  function applyTracks() {
    if (!locked) { page.style.gridTemplateColumns = ''; page.style.gridTemplateRows = ''; return; }
    var s = layoutSizes(current());
    page.style.gridTemplateColumns = s.cols.map(function(f) { return 'minmax(0, ' + f.toFixed(4) + 'fr)'; }).join(' ');
    page.style.gridTemplateRows = s.rows.map(function(f) { return 'minmax(0, ' + f.toFixed(4) + 'fr)'; }).join(' ');
  }

  function unionRect(names) {
    var r = null;
    names.forEach(function(n) {
      var b = PANES[n].getBoundingClientRect();
      r = r ? { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top),
                right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) } : b;
    });
    return r;
  }

  // Position the three splitters in the gaps, from the panes' live boxes.
  function placeLayoutSplits() {
    if (!locked) return;
    var def = layoutDef(current());
    var p = page.getBoundingClientRect();
    var j = sidebar.getBoundingClientRect();
    // The jump list reaches 14 px into the column gap for its scrollbar, so
    // this one splitter keeps to the gap's last 10 px.
    var dropTop = j.top + parseFloat(getComputedStyle(sidebar).marginTop) * -1;
    setBox(splits.col1, j.right + 14 - p.left, dropTop - p.top, 10, j.bottom - dropTop);
    var c3 = PANES[def.col3].getBoundingClientRect();
    setBox(splits.col2, c3.left - 18 - p.left, c3.top - p.top, 12, c3.height);
    var rr = unionRect(def.rowPanes);
    setBox(splits.row, rr.left - p.left, rr.top - 14 - p.top, rr.right - rr.left, 12);
  }
  function setBox(el, x, y, w, h) {
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.width = w + 'px'; el.style.height = h + 'px';
  }

  // Lock or unlock the page. Locked, the notes go to the bottom of the info
  // panel and the footer under the jump list, as there is no room below the
  // panels; unlocked they go back where index.html has them.
  function update() {
    var cls = document.body.classList;
    if (cls.contains('has-jump-loaded')) jumpShown = true;
    // Until the first jump has rendered, stored jumps (has-jumps) are enough:
    // init reopens one, and locking only then would show the scrolling page first.
    var want = current() !== 'scroll' && !mq.matches &&
      (cls.contains('has-jump-loaded') || (!jumpShown && cls.contains('has-jumps')));
    if (want !== locked) {
      locked = want;
      document.body.classList.toggle('layout-locked', locked);
      if (locked) {
        statsPanel.appendChild(notes);
        sidebar.appendChild(footer);
        window.scrollTo(0, 0);
      } else {
        document.getElementById('chartSection').appendChild(notes);
        main.appendChild(footer);
      }
    }
    applyTracks();
    placeLayoutSplits();
  }

  // Panels slide from their old box to the new one (FLIP). Their content is
  // hidden on the way, since a scaled chart or map looks smeared, and fades
  // back in once they land; the chart and map have already been resized to
  // the new box by then (their ResizeObservers see the layout, not the
  // transform).
  window.switchPageLayout = function(id) {
    if (id === current()) return;
    writeStoredLayout(id);
    var panes = Object.keys(PANES).map(function(k) { return PANES[k]; });
    var before = panes.map(function(el) { return el.getBoundingClientRect(); });
    var wasLocked = locked;
    document.body.dataset.layout = id;
    update();
    renderLayoutMenu();
    var animate = (wasLocked || locked) &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate) return;
    document.body.classList.add('layout-moving');
    var pending = 0;
    panes.forEach(function(el, i) {
      var a = before[i], b = el.getBoundingClientRect();
      if (!a.width || !b.width || !a.height || !b.height) return;
      el.style.transition = 'none';
      el.style.transformOrigin = '0 0';
      el.style.transform = 'translate(' + (a.left - b.left) + 'px,' + (a.top - b.top) + 'px) scale(' +
        (a.width / b.width) + ',' + (a.height / b.height) + ')';
      pending++;
    });
    page.offsetWidth; // reflow: the inverted transforms are the first frame
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      // Snap to the end, then clear: a transition that never ran (a hidden
      // tab) would otherwise leave a pane at its inverted transform.
      panes.forEach(function(el) { el.style.transition = 'none'; el.style.transform = 'none'; });
      page.offsetWidth;
      panes.forEach(function(el) { el.style.transition = ''; el.style.transform = ''; el.style.transformOrigin = ''; });
      document.body.classList.remove('layout-moving');
      placeLayoutSplits();
    }
    panes.forEach(function(el) {
      if (!el.style.transform) return;
      el.style.transition = 'transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = '';
    });
    // transitionend can be skipped (a pane that didn't move, a hidden tab),
    // so a timer finishes it too.
    if (pending) {
      panes[0].addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 450);
    } else finish();
  };

  // ── Splitter drag ──
  // Columns 1|2 trade the jump list's width against the middle column, 2|3 the
  // middle column against the third; the row splitter trades the two rows.
  Object.keys(splits).forEach(function(k) {
    var el = splits[k];
    el.addEventListener('pointerdown', function(e) {
      if (!locked || e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      el.classList.add('dragging');
      document.body.style.userSelect = 'none';
      var id = current();
      var sizes = layoutSizes(id);
      var cs = getComputedStyle(page);
      var isRow = k === 'row';
      var total = isRow
        ? page.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.rowGap)
        : page.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2 * parseFloat(cs.columnGap);
      var arr = isRow ? sizes.rows : sizes.cols;
      // Fractions summing to 1, so each is that track's share of the page.
      var sum = arr.reduce(function(s, f) { return s + f; }, 0);
      for (var n = 0; n < arr.length; n++) arr[n] /= sum;
      var i = k === 'col2' ? 1 : 0;
      var a0 = arr[i], b0 = arr[i + 1];
      var minA = (isRow ? LAYOUT_MIN_ROW : (i === 0 ? LAYOUT_MIN_JUMPS : LAYOUT_MIN_COL)) / total;
      var minB = (isRow ? LAYOUT_MIN_ROW : LAYOUT_MIN_COL) / total;
      var start = isRow ? e.clientY : e.clientX;
      function move(ev) {
        var d = ((isRow ? ev.clientY : ev.clientX) - start) / total;
        d = Math.max(minA - a0, Math.min(b0 - minB, d));
        arr[i] = a0 + d;
        arr[i + 1] = b0 - d;
        saveLayoutSizes(id, sizes);
        applyTracks();
        placeLayoutSplits();
      }
      function up() {
        el.classList.remove('dragging');
        document.body.style.userSelect = '';
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      }
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    // Double-click resets this layout to its default sizes.
    el.addEventListener('dblclick', function() {
      saveLayoutSizes(current(), null);
      applyTracks();
      placeLayoutSplits();
    });
  });

  // Leaflet doesn't notice its container resizing; Chart.js does by itself.
  if (mapEl && typeof ResizeObserver === 'function') {
    var raf = 0;
    new ResizeObserver(function() {
      if (raf) return;
      raf = requestAnimationFrame(function() {
        raf = 0;
        if (state.mapInstance) state.mapInstance.invalidateSize();
      });
    }).observe(mapEl);
  }
  // has-jump-loaded comes and goes with the loaded jump (chart.js, main.js).
  new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  mq.addEventListener('change', update);
  window.addEventListener('resize', placeLayoutSplits);
  if (typeof ResizeObserver === 'function') new ResizeObserver(placeLayoutSplits).observe(page);

  document.body.dataset.layout = readStoredLayout();
  wirePickerButton(document.getElementById('layoutBtn'));
  renderLayoutMenu();
  update();
})();
