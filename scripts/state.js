// ── Shared application state ──
// Loaded first — all other scripts reference `state.*`
var state = {
  // Video overlay
  videoObjectURL: null,
  videoExitTime: null,
  currentFlightData: null,

  // Widget system
  widgets: [],
  selectedWidgetId: null,
  nextWidgetId: 1,
  widgetDragState: null, // { mode: 'move'|'resize', widgetId, startX, startY, origX, origY, origW, origH, handle }

  // App state
  currentJumpName: null,
  chartInstance: null,
  mapInstance: null,
  hoverMarker: null,
  mapHoverTooltip: null,
  lastRenderMap: null,
};

// ── Video time → flight data index mapping ──
function videoTimeToDataIndex(videoTime) {
  if (state.videoExitTime === null || !state.currentFlightData) return -1;
  const flightTime = videoTime - state.videoExitTime; // seconds relative to exit
  const { times } = state.currentFlightData;
  let closest = 0, minDiff = Math.abs(times[0] - flightTime);
  for (let i = 1; i < times.length; i++) {
    const diff = Math.abs(times[i] - flightTime);
    if (diff < minDiff) { minDiff = diff; closest = i; }
    else break; // times are sorted, once diff increases we passed the closest
  }
  return closest;
}

// ── Safe radio value reader with fallback ──
function getRadioValue(name, fallback) {
  const el = document.querySelector('input[name="' + name + '"]:checked');
  return el ? el.value : fallback;
}

// ── Debounced widget layout save ──
// Coalesces the many mutations during a drag-resize gesture or rapid config
// toggling into a single IndexedDB write.
// `flushSaveWidgetLayout` cancels any pending timer and saves immediately —
// must be called before any code that empties `state.widgets`, otherwise the
// pending timer would fire after the clear and clobber the saved layout.
(function() {
  let timer = null;
  state.scheduleSaveWidgetLayout = function() {
    if (typeof saveWidgetLayout !== 'function') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveWidgetLayout();
    }, 200);
  };
  state.flushSaveWidgetLayout = function() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (typeof saveWidgetLayout === 'function') saveWidgetLayout();
  };
})();

// ── Video content area helper ──
function getVideoContentRect() {
  const video = document.getElementById('videoPreview');
  const elemW = video.clientWidth, elemH = video.clientHeight;
  const vidAspect = video.videoWidth / video.videoHeight;
  const elemAspect = elemW / elemH;
  let contentW, contentH;
  if (vidAspect > elemAspect) {
    contentW = elemW; contentH = elemW / vidAspect;
  } else {
    contentH = elemH; contentW = elemH * vidAspect;
  }
  const offX = (elemW - contentW) / 2;
  const offY = (elemH - contentH) / 2;
  return { offX, offY, contentW, contentH, elemW, elemH };
}
