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
