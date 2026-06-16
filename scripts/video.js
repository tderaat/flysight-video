
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

function handleVideoFile(file) {
  const isVideoMime = (file.type || '').toLowerCase().startsWith('video/');
  const isVideoExt = /\.(mp4|webm|mov|m4v)$/i.test(file.name);
  if (!isVideoMime && !isVideoExt) {
    alert(t('video.errDropVideo'));
    return;
  }
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
  video.addEventListener('error', function() {
    alert(t('video.errLoad'));
  }, { once: true });

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
      const t = Math.min(trimStart + i / FPS, trimEnd, Math.max(0, video.duration - 0.01));
      await seekVideoTo(video, t);

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
