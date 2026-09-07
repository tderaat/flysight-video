
// ── Video Overlay ──

function openVideoModal() {
  if (!state.currentJumpName) return;
  document.getElementById('videoModal').classList.add('open');
}

function closeVideoModal() {
  document.getElementById('videoModal').classList.remove('open');

  const v = document.getElementById('videoPreview');
  if (v) {
    if (!v.paused) v.pause();
    v.removeAttribute('src');
    v.load();
  }
  const playBtn = document.getElementById('videoPlayBtn');
  if (playBtn) playBtn.textContent = t('video.play');

  if (state.videoObjectURL) URL.revokeObjectURL(state.videoObjectURL);
  state.videoObjectURL = null;

  state.videoExitTime = null;
  document.getElementById('videoExitTimecode').textContent = t('video.notSet');
  document.getElementById('videoTimecode').textContent = '0:00.000';
  document.getElementById('videoDuration').textContent = '/ 0:00.000';
  document.getElementById('videoScrubber').value = 0;

  // Flush any pending debounced save with the current populated widgets
  // BEFORE we clear them, otherwise a stale timer would save an empty layout.
  if (typeof state.flushSaveWidgetLayout === 'function') state.flushSaveWidgetLayout();

  state.widgets = [];
  state.selectedWidgetId = null;
  state.widgetDragState = null;
  if (typeof updateWidgetSettingsPanel === 'function') updateWidgetSettingsPanel();

  document.getElementById('videoStep1').style.display = '';
  document.getElementById('videoStep2').style.display = 'none';
  document.getElementById('widgetsSection').style.display = 'none';
  document.getElementById('exportSection').style.display = 'none';

  if (typeof hideVideoConvertOffer === 'function') hideVideoConvertOffer();
  if (typeof clearVideoPageDropOverlay === 'function') clearVideoPageDropOverlay();
}

// Close modal on Escape (backdrop clicks are ignored — only the X button closes)
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('videoModal').classList.contains('open')) closeVideoModal();
});

// Video dropzone
(function() {
  const dz = document.getElementById('videoDropzone');
  const fi = document.getElementById('videoFileInput');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleVideoFile(e.dataTransfer.files[0]);
  });
  fi.addEventListener('change', () => { if (fi.files.length) handleVideoFile(fi.files[0]); });
})();

// ── Video load diagnostics ──
// A <video> element reports a failed load as a bare `error` event, so a codec
// the browser cannot decode is indistinguishable from a corrupt file. The most
// common cause by far is H.265/HEVC footage (action cameras and phones default
// to it), which browsers do not reliably decode even though the file is a
// perfectly valid .mp4. To say so instead of guessing, we read the video
// track's sample-entry fourcc straight out of the file's ISO-BMFF boxes.

// Video sample-entry fourccs mapped to the codec name shown to the user.
// Codec names are proper nouns, so they are not translated.
var VIDEO_CODEC_NAMES = {
  avc1: 'H.264/AVC', avc3: 'H.264/AVC',
  hev1: 'H.265/HEVC', hvc1: 'H.265/HEVC',
  dvh1: 'Dolby Vision (H.265)', dvhe: 'Dolby Vision (H.265)', dav1: 'Dolby Vision (AV1)',
  av01: 'AV1', vp09: 'VP9', vp08: 'VP8',
  apch: 'Apple ProRes', apcn: 'Apple ProRes', apcs: 'Apple ProRes',
  apco: 'Apple ProRes', ap4h: 'Apple ProRes', ap4x: 'Apple ProRes',
  mp4v: 'MPEG-4 Part 2', mjpa: 'Motion JPEG', mjpb: 'Motion JPEG',
  dvc: 'DV', dvcp: 'DV', 'rle ': 'QuickTime RLE',
};

// Fourccs no browser is expected to decode, so finding one is a definitive
// explanation. HEVC is handled separately since some browsers do support it.
var UNPLAYABLE_FOURCC = [
  'dvh1', 'dvhe', 'dav1',
  'apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x',
  'mp4v', 'mjpa', 'mjpb', 'dvc', 'dvcp', 'rle ',
];

// MediaError.code -> a short translated reason for the generic message.
var MEDIA_ERROR_KEYS = {
  1: 'video.mediaErrAborted',
  2: 'video.mediaErrNetwork',
  3: 'video.mediaErrDecode',
  4: 'video.mediaErrSrc',
};

// Deliberately NOT probed with canPlayType() or mediaCapabilities.decodingInfo():
// both lie. Firefox 155 on Windows reports 'probably' and
// supported/smooth/powerEfficient=true for HEVC, then fails the actual load with
// MEDIA_ERR_DECODE ("Utility MF Media Engine CDM only support for media engine
// playback"). Re-tagging hev1 to hvc1 does not help it either. So the fourcc
// from the file is the only trustworthy signal, and the HEVC message points at
// Chrome/Edge (which do decode it here, WebCodecs included) or a re-encode.

function readFileBytes(file, start, length) {
  var end = Math.min(start + length, file.size);
  if (end <= start) return Promise.resolve(new Uint8Array(0));
  return file.slice(start, end).arrayBuffer().then(function(buf) {
    return new Uint8Array(buf);
  });
}

function fourccAt(bytes, idx) {
  if (idx + 4 > bytes.length) return '';
  return String.fromCharCode(bytes[idx], bytes[idx + 1], bytes[idx + 2], bytes[idx + 3]);
}

// Walks the top-level ISO-BMFF box list (MP4 and MOV share it) and returns the
// bytes of `moov`, or null for anything we cannot read (WebM, truncated file,
// a CSV someone renamed to .mp4).
//
// Memoized on the File object, because both the codec sniff and the duration
// read want the same bytes and `moov` can run to a few MB.
var MAX_MOOV = 32 * 1024 * 1024;
var moovMemo = { file: null, promise: null };

function readMoovBytes(file) {
  if (moovMemo.file === file) return moovMemo.promise;
  var offset = 0;
  var guard = 0;

  function step() {
    if (offset + 8 > file.size || guard++ > 64) return Promise.resolve(null);
    return readFileBytes(file, offset, 16).then(function(head) {
      if (head.length < 8) return null;
      var dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
      var size = dv.getUint32(0);
      var type = fourccAt(head, 4);
      var headerLen = 8;
      if (size === 1) {
        // 64-bit largesize. Exact as a JS number well past any real file size.
        if (head.length < 16) return null;
        size = dv.getUint32(8) * 4294967296 + dv.getUint32(12);
        headerLen = 16;
      } else if (size === 0) {
        size = file.size - offset; // Box extends to end of file.
      }
      if (size < headerLen) return null;
      if (type !== 'moov') {
        offset += size;
        return step();
      }
      return readFileBytes(file, offset + headerLen, Math.min(size - headerLen, MAX_MOOV));
    });
  }

  moovMemo.file = file;
  moovMemo.promise = step().catch(function() { return null; });
  return moovMemo.promise;
}

// Reads the first video sample entry's fourcc out of `moov`'s `stsd` tables.
//
// The fourcc is NOT searched for directly: `ftyp`'s compatible-brands list can
// contain codec-looking brands (this repo's own sample file is tagged `avc1`
// while its track is `hev1`). Reading it at a fixed offset inside `stsd`
// (+16: version/flags, entry_count, entry size, then the fourcc) is exact.
function sniffVideoTrackFourcc(file) {
  return readMoovBytes(file).then(function(moov) {
    if (!moov) return null;
    for (var i = 0; i + 20 <= moov.length; i++) {
      if (moov[i] !== 0x73 || fourccAt(moov, i) !== 'stsd') continue;
      var cc = fourccAt(moov, i + 16);
      if (VIDEO_CODEC_NAMES[cc]) return cc;
    }
    return null;
  });
}

// Clip length in seconds, straight out of `mvhd`. The point is that this works
// on a file the browser cannot decode a single frame of, which is exactly when
// the conversion estimate needs a duration and `<video>` cannot supply one.
function readMp4DurationSec(file) {
  return readMoovBytes(file).then(function(moov) {
    if (!moov) return null;
    var dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
    for (var i = 0; i + 32 <= moov.length; i++) {
      if (moov[i] !== 0x6d || fourccAt(moov, i) !== 'mvhd') continue;
      var version = moov[i + 4];
      // Past the fourcc, then version (1) + flags (3).
      var p = i + 8;
      var timescale, duration;
      if (version === 1) {
        p += 16; // creation + modification, 8 bytes each
        if (p + 12 > moov.length) return null;
        timescale = dv.getUint32(p);
        duration = Number(dv.getBigUint64(p + 4));
      } else {
        p += 8; // creation + modification, 4 bytes each
        if (p + 8 > moov.length) return null;
        timescale = dv.getUint32(p);
        duration = dv.getUint32(p + 4);
        if (duration === 0xFFFFFFFF) return null; // "unknown" sentinel
      }
      if (!timescale) return null;
      var secs = duration / timescale;
      // A day is a generous ceiling and rules out the 64-bit unknown sentinel.
      return secs > 0 && secs < 86400 ? secs : null;
    }
    return null;
  });
}

// A successful metadata load is NOT proof the browser can show the footage.
// Given an H.265 file it has no decoder for, Chrome fires loadedmetadata AND
// loadeddata, reports the right dimensions and duration and a readyState of 4,
// and then produces no frames at all: getVideoPlaybackQuality().totalVideoFrames
// stays 0, the first seek never completes, and the pipeline only fails later
// with PIPELINE_ERROR_DECODE. Left unchecked that is a black preview with no
// explanation, which is exactly what a user sees. (Firefox is more honest and
// fails during the load, so the `error` listener catches it there.)
//
// So force the first frame out of the decoder and wait for it. Frames are only
// counted once something advances the presentation, which is why this seeks
// rather than just reading the counter after loadeddata (it is 0 at that point
// even for a perfectly good H.264 file).
//
// A working file resolves in a few tens of milliseconds (measured 26 ms for the
// repo's H.264 sample), so the happy path pays nothing.
var FIRST_FRAME_TIMEOUT_MS = 6000;

function probeFirstFrame(video) {
  return new Promise(function(resolve) {
    var settled = false;
    var rvfcId = null;

    function decodedFrames() {
      try {
        // null = browser will not say, so give the file the benefit of the doubt.
        return video.getVideoPlaybackQuality
          ? video.getVideoPlaybackQuality().totalVideoFrames
          : null;
      } catch (e) { return null; }
    }

    function finish(ok) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      if (rvfcId != null && video.cancelVideoFrameCallback) {
        try { video.cancelVideoFrameCallback(rvfcId); } catch (e) {}
      }
      resolve(ok);
    }

    function onSeeked() { finish(true); }
    function onError() { finish(false); }

    // Only a decoder that has produced nothing at all counts as a failure: a
    // slow seek on a huge file is fine as long as frames are coming out.
    var timer = setTimeout(function() { finish(decodedFrames() !== 0); }, FIRST_FRAME_TIMEOUT_MS);

    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    if (video.requestVideoFrameCallback) {
      rvfcId = video.requestVideoFrameCallback(function() { finish(true); });
    }
    try {
      video.currentTime = Math.min(0.04, (video.duration || 1) / 100);
    } catch (e) {
      finish(true); // Cannot probe, so do not stand in the user's way.
    }
  });
}

// Called from the <video> `error` handler. Everything here is best-effort: if
// the sniff fails we still surface the MediaError reason.
function reportVideoLoadError(file, mediaError) {
  var reason = t(MEDIA_ERROR_KEYS[mediaError && mediaError.code] || 'video.mediaErrUnknown');
  var detail = mediaError && mediaError.message ? String(mediaError.message).trim() : '';
  if (detail) reason += ': ' + detail;

  sniffVideoTrackFourcc(file).catch(function() { return null; }).then(function(fourcc) {
    console.warn('[FlySight] video load failed', {
      file: file.name, type: file.type, size: file.size, fourcc: fourcc,
      mediaError: mediaError ? { code: mediaError.code, message: mediaError.message } : null,
    });

    // ffmpeg.wasm can decode what the browser cannot, so offer an in-place
    // conversion rather than an alert the user has to act on elsewhere.
    // See scripts/convert.js (not available on file:// origins).
    if (typeof canOfferVideoConvert === 'function' && canOfferVideoConvert(fourcc)) {
      showVideoConvertOffer(file, fourcc, VIDEO_CODEC_NAMES[fourcc]);
      return;
    }

    if (fourcc === 'hev1' || fourcc === 'hvc1') {
      alert(t('video.errLoadHevc', { fourcc: fourcc, name: file.name }));
    } else if (UNPLAYABLE_FOURCC.indexOf(fourcc) >= 0) {
      alert(t('video.errLoadCodec', {
        codec: VIDEO_CODEC_NAMES[fourcc], fourcc: fourcc, name: file.name,
      }));
    } else {
      alert(t('video.errLoadDetail', { reason: reason, name: file.name }));
    }
  });
}

function handleVideoFile(file) {
  const isVideoMime = (file.type || '').toLowerCase().startsWith('video/');
  const isVideoExt = /\.(mp4|webm|mov|m4v)$/i.test(file.name);
  if (!isVideoMime && !isVideoExt) {
    alert(t('video.errDropVideo'));
    return;
  }
  // A previous drop may have left the codec-conversion offer up.
  if (typeof hideVideoConvertOffer === 'function') hideVideoConvertOffer();
  if (state.videoObjectURL) URL.revokeObjectURL(state.videoObjectURL);
  state.videoObjectURL = URL.createObjectURL(file);
  const video = document.getElementById('videoPreview');

  // Kick off the widget-layout restore in parallel with video loading. Doing it
  // here (rather than inside loadedmetadata) avoids any race with the loadeddata
  // event firing before the restore completes — state.widgets is populated as
  // soon as IDB returns, and the next drawOverlayPreview (from loadeddata,
  // timeupdate, or markVideoExit) renders them.
  (async () => {
    try {
      const saved = await loadWidgetLayout();
      if (!saved || !saved.length) return;
      state.widgets = saved.map(w => ({
        id: w.id,
        type: w.type,
        x: w.x,
        y: w.y,
        widgetScale: w.widgetScale,
        config: { ...w.config },
      }));
      const maxId = state.widgets.reduce((m, w) => Math.max(m, w.id || 0), 0);
      state.nextWidgetId = maxId + 1;
      state.selectedWidgetId = null;
      if (typeof updateWidgetSettingsPanel === 'function') updateWidgetSettingsPanel();
      drawOverlayPreview();
    } catch {
      // Fall back to empty layout silently.
    }
  })();

  // Attach listeners BEFORE setting src so we never miss the metadata event.
  video.addEventListener('loadedmetadata', function onMeta() {
    video.removeEventListener('loadedmetadata', onMeta);
    // probeFirstFrame() owns error handling from here, so there is exactly one
    // path into reportVideoLoadError().
    video.removeEventListener('error', onLoadError);

    probeFirstFrame(video).then(function(playable) {
      // The user closed the modal while we were probing: closeVideoModal()
      // strips the src, and its own load() is what raised the error we may
      // have just caught. Nothing left to report.
      if (!video.getAttribute('src')) return;

      if (!playable) {
        reportVideoLoadError(file, video.error);
        return;
      }

      video.currentTime = 0;
      document.getElementById('videoDuration').textContent = '/ ' + formatVideoTimecode(video.duration);
      document.getElementById('videoScrubber').max = Math.floor(video.duration * 1000);
      document.getElementById('videoStep1').style.display = 'none';
      document.getElementById('videoStep2').style.display = 'block';
      // Reset exit
      state.videoExitTime = null;
      document.getElementById('videoExitTimecode').textContent = t('video.notSet');
      // Redraw — by now any in-flight restore has likely landed, and even if not,
      // drawOverlayPreview will re-fire from the loadeddata listener.
      drawOverlayPreview();
    });
  });
  // A load that fails outright fires a bare `error` event; reportVideoLoadError()
  // inspects the file to explain why. Handed over to probeFirstFrame() once
  // metadata is in, because a browser with no usable decoder gets that far and
  // only fails afterwards.
  function onLoadError() {
    video.removeEventListener('error', onLoadError);
    reportVideoLoadError(file, video.error);
  }
  video.addEventListener('error', onLoadError);

  video.src = state.videoObjectURL;
  video.muted = true;
  video.load();
}

// Playback controls
function toggleVideoPlay() {
  const v = document.getElementById('videoPreview');
  if (v.paused) {
    v.play();
    document.getElementById('videoPlayBtn').textContent = t('video.pause');
  } else {
    v.pause();
    document.getElementById('videoPlayBtn').textContent = t('video.play');
  }
}

(function() {
  const video = document.getElementById('videoPreview');
  const scrubber = document.getElementById('videoScrubber');
  video.addEventListener('timeupdate', () => {
    document.getElementById('videoTimecode').textContent = formatVideoTimecode(video.currentTime);
    scrubber.value = Math.floor(video.currentTime * 1000);
    drawOverlayPreview();
  });
  video.addEventListener('ended', () => {
    document.getElementById('videoPlayBtn').textContent = t('video.play');
  });
  scrubber.addEventListener('input', () => {
    video.currentTime = scrubber.value / 1000;
  });
})();

function formatVideoTimecode(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(3);
  return m + ':' + s.padStart(6, '0');
}

// Exit sync
function markVideoExit() {
  const v = document.getElementById('videoPreview');
  state.videoExitTime = v.currentTime;
  document.getElementById('videoExitTimecode').textContent = formatVideoTimecode(state.videoExitTime);
  document.getElementById('widgetsSection').style.display = '';
  document.getElementById('exportSection').style.display = '';
  drawOverlayPreview();
}

// ── Export pipeline ──

// Persisted "reliable mode" preference (synchronous localStorage, matching the
// flysight_scores / flysight_exit_overrides convention).
function getReliableExportPref() {
  try { return localStorage.getItem('flysight_reliable_export') === '1'; } catch { return false; }
}
function setReliableExportPref(on) {
  try { localStorage.setItem('flysight_reliable_export', on ? '1' : '0'); } catch {}
}

// Restore + persist the reliable-mode toggle.
(function() {
  const toggle = document.getElementById('reliableModeToggle');
  if (!toggle) return;
  toggle.checked = getReliableExportPref();
  toggle.addEventListener('change', () => setReliableExportPref(toggle.checked));
})();

// Persisted "include full descent" preference (default off).
function getFullDescentPref() {
  try { return localStorage.getItem('flysight_full_descent_export') === '1'; } catch { return false; }
}
function setFullDescentPref(on) {
  try { localStorage.setItem('flysight_full_descent_export', on ? '1' : '0'); } catch {}
}
(function() {
  const toggle = document.getElementById('fullDescentToggle');
  if (!toggle) return;
  toggle.checked = getFullDescentPref();
  toggle.addEventListener('change', () => setFullDescentPref(toggle.checked));
})();

// Build an overlay-data slice [exit-5s .. maxTimeRel] from the full-recording
// dataset, matching the state.currentFlightData contract. Used by the export's
// "full descent" option so widgets keep updating under canopy through landing
// instead of clamping to the end of the default (canopy+5s) jump window.
function buildExtendedFlightData(maxTimeRel) {
  const full = state.currentFlightDataFull;
  if (!full || !full.times || !full.times.length) return null;

  let s = full.times.findIndex(t => t >= -5);
  if (s < 0) s = 0;
  let e = full.times.length - 1;
  for (let i = s; i < full.times.length; i++) {
    if (full.times[i] > maxTimeRel) { e = i - 1; break; }
  }
  if (e < s) e = s;

  const slice = arr => arr.slice(s, e + 1);
  return {
    times: slice(full.times),
    altitudes: slice(full.altitudes),
    vertSpeeds: slice(full.vertSpeeds),
    horzSpeeds: slice(full.horzSpeeds),
    diveAngles: slice(full.diveAngles),
    lats: slice(full.lats),
    lons: slice(full.lons),
    velNs: slice(full.velNs),
    velEs: slice(full.velEs),
    exitIdx: Math.max(0, full.exitIdx - s),
    canopyIdx: Math.max(0, full.canopyIdx - s),
    speedScore: full.speedScore,
    perfWindowStartTime: full.perfWindowStartTime,
    perfWindowEndTime: full.perfWindowEndTime,
    best3sStart: full.best3sStart,
    best3sEnd: full.best3sEnd,
    canopyTimeRel: full.canopyTimeRel,
    landingTimeRel: full.landingTimeRel,
  };
}

// Render every placed widget onto ctx for the given flight-data index.
// Shared by both export paths (the on-screen preview keeps its own copy in
// widgets/core.js because it also draws selection handles + content translate).
function drawExportWidgets(ctx, contentRect, dataIdx) {
  for (const widget of state.widgets) {
    const typeDef = WIDGET_TYPES[widget.type];
    if (!typeDef) continue;
    const opacity = getWidgetOpacity(widget, dataIdx);
    typeDef.render(ctx, contentRect, widget, dataIdx, null, null, opacity);
  }
}

// Seek a (paused) video to t and resolve once the frame is decoded, with a
// timeout so a slow/broken decode can never hang the export indefinitely.
function seekVideoTo(video, t) {
  return new Promise((resolve, reject) => {
    let done = false;
    function cleanup() { clearTimeout(timer); video.removeEventListener('seeked', onSeeked); }
    function onSeeked() { if (done) return; done = true; cleanup(); resolve(); }
    const timer = setTimeout(() => {
      if (done) return; done = true; cleanup();
      reject(new Error('Timed out seeking the video (decode too slow or file unreadable).'));
    }, 8000);
    video.addEventListener('seeked', onSeeked);
    if (Math.abs(video.currentTime - t) < 1e-4) { done = true; cleanup(); resolve(); return; }
    video.currentTime = t;
  });
}

// Called by the Cancel button (#exportCancelBtn). The active export path
// registers its teardown on state.activeExportCancel during startExport.
function cancelExport() {
  if (state.activeExportCancel) state.activeExportCancel();
}

function startExport() {
  if (state.videoExitTime === null) { alert(t('video.errMarkExit')); return; }
  if (!state.currentFlightData) { alert(t('video.errNoFlightData')); return; }
  if (state.widgets.length === 0) { alert(t('video.errNoWidgets')); return; }

  // Deselect widget and block UI during export
  state.selectedWidgetId = null;
  updateWidgetSettingsPanel();
  drawOverlayPreview();
  const modalBody = document.querySelector('#videoModal .modal-body');
  modalBody.style.pointerEvents = 'none';
  modalBody.style.opacity = '0.7';

  const video = document.getElementById('videoPreview');

  const trimStart = Math.max(0, state.videoExitTime - 5);
  const canopyFlightTime = state.currentFlightData.times[state.currentFlightData.canopyIdx] || state.currentFlightData.times[state.currentFlightData.times.length - 1];

  // "Include full descent": run through landing + 5 s (or to the video end when
  // landing wasn't detected), and swap in an overlay dataset that reaches that
  // far so widgets keep updating under canopy. Restored in finishExport/failExport.
  const fullDescentToggle = document.getElementById('fullDescentToggle');
  const wantFullDescent = !!(fullDescentToggle && fullDescentToggle.checked);
  let restoreFlightData = null;
  let trimEnd;
  if (wantFullDescent) {
    const landingTimeRel = state.currentFlightData.landingTimeRel;
    trimEnd = (Number.isFinite(landingTimeRel) && landingTimeRel > 0)
      ? Math.min(video.duration, state.videoExitTime + landingTimeRel + 5)
      : video.duration;
    const ext = buildExtendedFlightData(trimEnd - state.videoExitTime);
    if (ext) {
      const original = state.currentFlightData;
      state.currentFlightData = ext;
      restoreFlightData = () => { state.currentFlightData = original; };
    }
  } else {
    trimEnd = Math.min(video.duration, state.videoExitTime + canopyFlightTime);
  }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  const contentRect = { width: canvas.width, height: canvas.height };

  const progressEl = document.getElementById('exportProgress');
  const fillEl = document.getElementById('progressFill');
  const textEl = document.getElementById('progressText');
  const btnEl = document.getElementById('exportBtn');
  const cancelBtnEl = document.getElementById('exportCancelBtn');

  // The active export registers a cancel handler here; the Cancel button calls
  // cancelExport(), which invokes it. Reset on every start and cleared by restoreUI.
  state.activeExportCancel = null;
  if (cancelBtnEl) { cancelBtnEl.disabled = false; cancelBtnEl.textContent = t('video.cancel'); }

  function restoreUI() {
    progressEl.style.display = 'none';
    btnEl.disabled = false;
    state.activeExportCancel = null;
    document.getElementById('videoPlayBtn').textContent = 'Play';
    modalBody.style.pointerEvents = '';
    modalBody.style.opacity = '';
  }
  function setProgress(pct, label) {
    fillEl.style.width = Math.min(Math.max(pct, 0), 100) + '%';
    textEl.textContent = label;
  }
  function restoreSwappedData() {
    if (restoreFlightData) { restoreFlightData(); restoreFlightData = null; drawOverlayPreview(); }
  }
  function finishExport(blob, fileExt) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.currentJumpName.replace(/\.[^.]+$/, '') + '_overlay' + fileExt;  // suffix kept untranslated for stable filenames
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    restoreSwappedData();
    restoreUI();
  }
  function failExport(message) {
    try { if (!video.paused) video.pause(); } catch {}
    restoreSwappedData();
    restoreUI();
    alert(message);
  }
  // Cancellation: tear down quietly with no download and no alert.
  function abortExport() {
    try { if (!video.paused) video.pause(); } catch {}
    restoreSwappedData();
    restoreUI();
  }

  progressEl.style.display = 'block';
  btnEl.disabled = true;
  setProgress(0, t('video.preparing'));

  const opts = { video, canvas, ctx, contentRect, trimStart, trimEnd, setProgress, finishExport, failExport, abortExport };

  const toggle = document.getElementById('reliableModeToggle');
  const wantReliable = !!(toggle && toggle.checked);
  const webCodecsAvailable =
    typeof window.VideoEncoder === 'function' &&
    typeof window.VideoFrame === 'function' &&
    (typeof window.Mp4Muxer !== 'undefined' || typeof window.WebMMuxer !== 'undefined');

  if (wantReliable && webCodecsAvailable) {
    exportWithWebCodecs(opts);
  } else {
    if (wantReliable && !webCodecsAvailable) {
      setProgress(0, t('video.reliableUnavailable'));
    }
    exportRealtime(opts);
  }
}

// Real-time path: canvas.captureStream + MediaRecorder driven by playback.
// Fast on capable machines; hardened so a decode stall surfaces a message and
// delivers a partial file instead of hanging silently.
function exportRealtime(opts) {
  const { video, canvas, ctx, contentRect, trimStart, trimEnd, setProgress, finishExport, failExport, abortExport } = opts;

  let mimeType = 'video/webm;codecs=vp9';
  let fileExt = '.webm';
  if (MediaRecorder.isTypeSupported('video/mp4')) {
    mimeType = 'video/mp4';
    fileExt = '.mp4';
  } else if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm';
  }

  let stream, recorder;
  try {
    stream = canvas.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
  } catch (e) {
    failExport(t('video.errRecorder', { msg: (e && e.message ? e.message : e) }));
    return;
  }

  const chunks = [];
  let finished = false;   // delivered a result
  let aborted = false;    // error/abort already surfaced
  let cancelled = false;  // user pressed Cancel
  let stopping = false;   // stopRecording already in progress
  let watchdog = null;
  let lastTime = -1;
  let stalledChecks = 0;

  function cleanupListeners() {
    if (watchdog !== null) { clearInterval(watchdog); watchdog = null; }
    video.removeEventListener('error', onVideoError);
    video.removeEventListener('ended', onVideoEnded);
  }
  function stopRecording() {
    if (stopping) return;
    stopping = true;
    try { if (!video.paused) video.pause(); } catch {}
    cleanupListeners();
    try { recorder.stop(); } catch {}
  }
  function onVideoEnded() {
    // Natural end of a short video (trimEnd was capped to video.duration, e.g.
    // when "full descent" is on but the footage stops before landing). Once the
    // video ends, requestVideoFrameCallback stops firing, so renderFrame can't
    // catch this itself — deliver whatever we captured.
    if (finished || aborted) return;
    stopRecording();
  }
  function onVideoError() {
    if (finished || aborted) return;
    aborted = true;
    cleanupListeners();
    try { recorder.stop(); } catch {}
    failExport(t('video.errPlayback'));
  }

  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onerror = e => {
    if (finished || aborted) return;
    aborted = true;
    cleanupListeners();
    failExport(t('video.errRecording', { msg: (e && e.error && e.error.message ? e.error.message : 'unknown error') }));
  };
  recorder.onstop = () => {
    cleanupListeners();
    if (aborted) return;                 // failExport already restored the UI
    if (cancelled) { abortExport(); return; }   // user cancelled: discard, no download
    if (chunks.length === 0) { failExport(t('video.errNoData')); return; }
    finished = true;
    const blob = new Blob(chunks, { type: mimeType });
    finishExport(blob, fileExt);
    if (stalledChecks > 0) {
      alert(t('video.errStalled'));
    }
  };

  video.addEventListener('error', onVideoError);
  video.addEventListener('ended', onVideoEnded);

  state.activeExportCancel = () => {
    if (finished || aborted || cancelled) return;
    cancelled = true;
    document.getElementById('progressText').textContent = t('video.cancelling');
    document.getElementById('exportCancelBtn').disabled = true;
    stopRecording();   // recorder.onstop sees `cancelled` and discards the result
  };

  function renderFrame() {
    if (aborted || finished) return;
    if (video.currentTime >= trimEnd || video.paused || video.ended) {
      stopRecording();
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataIdx = videoTimeToDataIndex(video.currentTime);
    drawExportWidgets(ctx, contentRect, dataIdx);

    const pct = ((video.currentTime - trimStart) / (trimEnd - trimStart)) * 100;
    setProgress(pct, t('video.exportingPct', { pct: Math.round(pct) }));

    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(renderFrame);
    } else {
      requestAnimationFrame(renderFrame);
    }
  }

  video.muted = true;
  seekVideoTo(video, trimStart).then(() => {
    if (aborted) return;
    try { recorder.start(); } catch (e) { failExport(t('video.errRecorderStart', { msg: (e && e.message ? e.message : e) })); return; }
    video.play();
    lastTime = video.currentTime;

    // Watchdog: a stalled (but not "paused") video is the silent-hang case —
    // requestVideoFrameCallback simply stops firing. Detect no progress and
    // either nudge playback once or stop with whatever we captured.
    watchdog = setInterval(() => {
      if (finished || aborted) return;
      // Reaching trimEnd is the normal finish; if rVFC didn't fire to catch it
      // (e.g. the video ended at exactly trimEnd), stop here instead.
      if (video.currentTime >= trimEnd) { stopRecording(); return; }
      if (Math.abs(video.currentTime - lastTime) < 1e-3) {
        stalledChecks++;
        if (stalledChecks === 1) {
          try { video.play(); } catch {}
        } else {
          stopRecording();
        }
      } else {
        stalledChecks = 0;
        lastTime = video.currentTime;
      }
    }, 1500);

    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(renderFrame);
    } else {
      requestAnimationFrame(renderFrame);
    }
  }).catch(e => failExport(t('video.errSeek', { msg: (e && e.message ? e.message : e) })));
}

// Reliable path: WebCodecs VideoEncoder, frame-by-frame. Decoupled from
// real-time playback, so a slow CPU only makes it take longer — it never
// stalls and the output timing is frame-accurate (explicit timestamps).
async function exportWithWebCodecs(opts) {
  const { video, canvas, ctx, contentRect, trimStart, trimEnd, setProgress, finishExport, failExport, abortExport } = opts;

  const FPS = 30;
  const width = canvas.width;
  const height = canvas.height;

  async function codecSupported(codecStr) {
    try {
      const s = await window.VideoEncoder.isConfigSupported({ codec: codecStr, width, height });
      return !!(s && s.supported);
    } catch { return false; }
  }

  try {
    let muxer, target, codec, fileExt, mimeType;

    // Prefer Constrained Baseline H.264 (profile_idc 66 + constraint_set1):
    // Baseline forbids B-frames by spec, so the encoder cannot reorder frames.
    // High profile (avc1.640028) lets Firefox's encoder emit B-frames, which come
    // out in decode order with non-monotonic presentation timestamps that mp4-muxer
    // rejects ("DTS must be monotonically increasing"). We try Baseline at
    // decreasing levels (5.2 → 4.0 → 3.0) to fit the frame size, and only fall back
    // to High if no Baseline level is available. Levels: 34=5.2, 28=4.0, 1f=3.1.
    let h264Codec = null;
    if (typeof window.Mp4Muxer !== 'undefined') {
      for (const c of ['avc1.42E034', 'avc1.42E028', 'avc1.42E01F', 'avc1.640028']) {
        if (await codecSupported(c)) { h264Codec = c; break; }
      }
    }
    if (h264Codec) {
      codec = h264Codec;
      fileExt = '.mp4';
      mimeType = 'video/mp4';
      target = new window.Mp4Muxer.ArrayBufferTarget();
      muxer = new window.Mp4Muxer.Muxer({
        target,
        video: { codec: 'avc', width, height },
        fastStart: 'in-memory',
        // Firefox stamps canvas-built VideoFrames document-relative (ignoring our
        // explicit timestamp), so the first chunk isn't at 0. 'offset' normalizes
        // all timestamps to a zero base. No-op on Chrome (first chunk already 0).
        firstTimestampBehavior: 'offset',
      });
    } else if (typeof window.WebMMuxer !== 'undefined' && await codecSupported('vp09.00.10.08')) {
      codec = 'vp09.00.10.08';
      fileExt = '.webm';
      mimeType = 'video/webm';
      target = new window.WebMMuxer.ArrayBufferTarget();
      muxer = new window.WebMMuxer.Muxer({
        target,
        video: { codec: 'V_VP9', width, height, frameRate: FPS },
        // See note above: normalize Firefox's non-zero first timestamp to 0.
        firstTimestampBehavior: 'offset',
      });
    } else {
      // No usable WebCodecs config here — fall back to the real-time path.
      setProgress(0, t('video.reliableUnavailable'));
      exportRealtime(opts);
      return;
    }

    let encoderError = null;
    const encoder = new window.VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { encoderError = e; },
    });
    // 'realtime' hints the encoder to avoid frame reordering. Firefox ignores it
    // for H.264 (hence the Baseline-profile codec choice above, which forbids
    // B-frames outright), but it's harmless and helps encoders that do honor it.
    encoder.configure({ codec, width, height, bitrate: 5_000_000, framerate: FPS, latencyMode: 'realtime' });

    const totalFrames = Math.max(1, Math.ceil((trimEnd - trimStart) * FPS));
    video.muted = true;
    try { if (!video.paused) video.pause(); } catch {}

    let cancelled = false;
    state.activeExportCancel = () => {
      if (cancelled) return;
      cancelled = true;
      document.getElementById('progressText').textContent = t('video.cancelling');
      document.getElementById('exportCancelBtn').disabled = true;
    };

    for (let i = 0; i < totalFrames; i++) {
      if (cancelled) break;
      if (encoderError) throw encoderError;
      // Never seek to exactly video.duration — some browsers won't fire 'seeked'
      // there, which would otherwise time out (e.g. a short clip that ends before
      // landing + 5 s, so trimEnd was capped to video.duration).
      // Not named `t` — that's the global translation function, used below.
      const seekTime = Math.min(trimStart + i / FPS, trimEnd, Math.max(0, video.duration - 0.01));
      await seekVideoTo(video, seekTime);

      ctx.drawImage(video, 0, 0, width, height);
      const dataIdx = videoTimeToDataIndex(video.currentTime);
      drawExportWidgets(ctx, contentRect, dataIdx);

      const frame = new window.VideoFrame(canvas, {
        timestamp: Math.round((i / FPS) * 1e6),
        duration: Math.round(1e6 / FPS),
      });
      encoder.encode(frame, { keyFrame: i % FPS === 0 });
      frame.close();

      const pct = ((i + 1) / totalFrames) * 100;
      setProgress(pct, t('video.exportingFrame', { i: i + 1, total: totalFrames }));

      // Backpressure: let the encoder drain so memory stays bounded.
      while (encoder.encodeQueueSize > FPS * 2 && !cancelled) {
        await new Promise(r => setTimeout(r, 10));
        if (encoderError) throw encoderError;
      }
    }

    if (cancelled) {
      try { encoder.close(); } catch {}
      abortExport();   // discard, no download
      return;
    }

    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: mimeType });
    finishExport(blob, fileExt);
  } catch (e) {
    failExport(t('video.errReliable', { msg: (e && e.message ? e.message : e) }));
  }
}

// Wire up preview updates
window.addEventListener('resize', drawOverlayPreview);

// Draw preview when video loads
document.getElementById('videoPreview').addEventListener('loadeddata', function() {
  drawOverlayPreview();
});
