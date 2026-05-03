
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
  if (playBtn) playBtn.textContent = 'Play';

  if (state.videoObjectURL) URL.revokeObjectURL(state.videoObjectURL);
  state.videoObjectURL = null;

  state.videoExitTime = null;
  document.getElementById('videoExitTimecode').textContent = 'Not set';
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

// Close modal on backdrop click or Escape
document.getElementById('videoModal').addEventListener('click', function(e) {
  if (e.target === this) closeVideoModal();
});
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
    alert('Please drop a video file (MP4, WebM, or MOV).');
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
    document.getElementById('videoExitTimecode').textContent = 'Not set';
    // Redraw — by now any in-flight restore has likely landed, and even if not,
    // drawOverlayPreview will re-fire from the loadeddata listener.
    drawOverlayPreview();
  });
  video.addEventListener('error', function() {
    alert('Could not load this video file. Try a different format (MP4, WebM).');
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
    document.getElementById('videoPlayBtn').textContent = 'Pause';
  } else {
    v.pause();
    document.getElementById('videoPlayBtn').textContent = 'Play';
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
    document.getElementById('videoPlayBtn').textContent = 'Play';
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

// Export pipeline
async function startExport() {
  if (state.videoExitTime === null) { alert('Please mark the exit moment first.'); return; }
  if (!state.currentFlightData) { alert('No flight data loaded.'); return; }
  if (state.widgets.length === 0) { alert('No widgets placed on the overlay.'); return; }

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
  const trimEnd = Math.min(video.duration, state.videoExitTime + canopyFlightTime);

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  let mimeType = 'video/webm;codecs=vp9';
  let fileExt = '.webm';
  if (MediaRecorder.isTypeSupported('video/mp4')) {
    mimeType = 'video/mp4';
    fileExt = '.mp4';
  } else if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm';
  }

  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.currentJumpName.replace(/\.[^.]+$/, '') + '_overlay' + fileExt;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.getElementById('exportProgress').style.display = 'none';
    document.getElementById('exportBtn').disabled = false;
    document.getElementById('videoPlayBtn').textContent = 'Play';
    // Unblock UI
    modalBody.style.pointerEvents = '';
    modalBody.style.opacity = '';
  };

  document.getElementById('exportProgress').style.display = 'block';
  document.getElementById('exportBtn').disabled = true;
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressText').textContent = 'Preparing...';

  video.currentTime = trimStart;
  video.muted = true;
  await new Promise(r => video.addEventListener('seeked', r, { once: true }));

  recorder.start();
  video.play();

  const contentRect = { width: canvas.width, height: canvas.height };

  function renderFrame() {
    if (video.currentTime >= trimEnd || video.paused || video.ended) {
      video.pause();
      recorder.stop();
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataIdx = videoTimeToDataIndex(video.currentTime);

    for (const widget of state.widgets) {
      const typeDef = WIDGET_TYPES[widget.type];
      if (!typeDef) continue;
      const opacity = getWidgetOpacity(widget, dataIdx);
      typeDef.render(ctx, contentRect, widget, dataIdx, null, null, opacity);
    }

    const pct = ((video.currentTime - trimStart) / (trimEnd - trimStart)) * 100;
    document.getElementById('progressFill').style.width = Math.min(pct, 100) + '%';
    document.getElementById('progressText').textContent = 'Exporting... ' + Math.round(pct) + '%';

    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(renderFrame);
    } else {
      requestAnimationFrame(renderFrame);
    }
  }

  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback(renderFrame);
  } else {
    requestAnimationFrame(renderFrame);
  }
}

// Wire up preview updates
window.addEventListener('resize', drawOverlayPreview);

// Draw preview when video loads
document.getElementById('videoPreview').addEventListener('loadeddata', function() {
  drawOverlayPreview();
});
