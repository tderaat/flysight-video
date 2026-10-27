
// ── Video Overlay ──

function openVideoModal() {
  if (!state.currentJumpName) return;
  updateVideoModalTitle();
  document.getElementById('videoModal').classList.add('open');
}

// "Video Overlay - <jump> (<score> km/h)", score omitted for an unscorable jump.
// Set from JS rather than data-i18n so a language switch keeps the jump part.
function updateVideoModalTitle() {
  const el = document.getElementById('videoModalTitle');
  if (!el) return;
  const score = state.currentFlightData && state.currentFlightData.speedScore;
  let title = t('video.title');
  if (state.currentJumpName) {
    title += ' - ' + state.currentJumpName;
    if (typeof score === 'number' && isFinite(score)) title += ' (' + score.toFixed(2) + ' km/h)';
  }
  el.textContent = title;
}

function closeVideoModal() {
  document.getElementById('videoModal').classList.remove('open');

  const v = document.getElementById('videoPreview');
  if (v) {
    if (!v.paused) v.pause();
    v.removeAttribute('src');
    v.load();
  }
  setVideoPlayButton(false);

  if (state.videoObjectURL) URL.revokeObjectURL(state.videoObjectURL);
  state.videoObjectURL = null;

  state.videoExitTime = null;
  state.videoCropStart = null;
  state.videoCropEnd = null;
  document.getElementById('videoExitTimecode').textContent = t('video.notSet');
  document.getElementById('videoTimecode').textContent = '0:00.000';
  document.getElementById('videoDuration').textContent = '/ 0:00.000';

  // Flush any pending debounced save with the current populated widgets
  // BEFORE we clear them, otherwise a stale timer would save an empty layout.
  if (typeof state.flushSaveWidgetLayout === 'function') state.flushSaveWidgetLayout();

  state.widgets = [];
  state.selectedWidgetId = null;
  state.widgetDragState = null;
  if (typeof updateWidgetSettingsPanel === 'function') updateWidgetSettingsPanel();

  document.getElementById('videoStep1').style.display = '';
  document.getElementById('videoStep2').style.display = 'none';
  state.videoStep = 1;
  refreshVideoSteps();

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

// ── Containers the <video> element does not open ──
// AVI and MPEG-TS (AVCHD's .mts/.m2ts) are not played by any browser, whatever
// codec they carry, so those files go straight to the ffmpeg.wasm converter
// without a load attempt. Matroska support varies by browser, so an .mkv is
// tried natively first and only sniffed here once that fails.
//
// Detected by magic bytes rather than extension, so a renamed file still lands
// on the right path. Every codec below is mapped onto the same keys as
// VIDEO_CODEC_NAMES, so the converter and its messages need no second table.
var CONTAINER_NAMES = { avi: 'AVI', mpegts: 'MPEG-TS', mkv: 'Matroska (MKV)' };
var CONTAINER_SNIFF_BYTES = 1024 * 1024;

Object.assign(VIDEO_CODEC_NAMES, {
  mp2v: 'MPEG-2', mjpg: 'Motion JPEG', div3: 'MS MPEG-4 v3',
});

// AVI BITMAPINFOHEADER biCompression values, upper-cased.
var AVI_FOURCC_MAP = {
  H264: 'avc1', X264: 'avc1', AVC1: 'avc1',
  HEVC: 'hev1', H265: 'hev1', HEV1: 'hev1', HVC1: 'hev1',
  XVID: 'mp4v', DIVX: 'mp4v', DX50: 'mp4v', FMP4: 'mp4v', MP4V: 'mp4v',
  DIV3: 'div3', MP43: 'div3',
  MJPG: 'mjpg', AVRN: 'mjpg',
};

// MPEG-TS PMT stream_type values for video.
var TS_STREAM_TYPES = { 0x01: 'mp2v', 0x02: 'mp2v', 0x10: 'mp4v', 0x1B: 'avc1', 0x24: 'hev1' };

// Matroska CodecID prefixes.
var MKV_CODEC_IDS = [
  ['V_MPEG4/ISO/AVC', 'avc1'], ['V_MPEGH/ISO/HEVC', 'hev1'], ['V_MPEG4/ISO/', 'mp4v'],
  ['V_MPEG2', 'mp2v'], ['V_MJPEG', 'mjpg'], ['V_VP9', 'vp09'], ['V_VP8', 'vp08'], ['V_AV1', 'av01'],
];

function asciiAt(bytes, idx, len) {
  var s = '';
  for (var i = idx; i < idx + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// RIFF chunks are little-endian and padded to an even length. hdrl holds the
// main header and one strl per stream; only the first video stream matters.
function sniffAvi(bytes) {
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var info = { container: 'avi', fourcc: null, durationSec: null };
  var avihSecs = null;

  function walk(start, end) {
    var p = start;
    while (p + 8 <= end && p + 8 <= bytes.length) {
      var id = asciiAt(bytes, p, 4);
      var size = dv.getUint32(p + 4, true);
      var body = p + 8;
      if (id === 'LIST' || id === 'RIFF') {
        var type = asciiAt(bytes, body, 4);
        if (type === 'hdrl' || type === 'strl') {
          if (walk(body + 4, Math.min(body + size, bytes.length))) return true;
        }
        if (type === 'movi') return false; // stream data follows; headers are done
      } else if (id === 'avih' && body + 20 <= bytes.length) {
        var usPerFrame = dv.getUint32(body, true);
        var frames = dv.getUint32(body + 16, true);
        if (usPerFrame && frames) avihSecs = frames * usPerFrame / 1e6;
      } else if (id === 'strh' && body + 36 <= bytes.length) {
        if (asciiAt(bytes, body, 4) !== 'vids') return false; // not video: next strl
        var scale = dv.getUint32(body + 20, true);
        var rate = dv.getUint32(body + 24, true);
        var length = dv.getUint32(body + 32, true);
        // strh's length covers the whole stream, unlike avih's frame count, which
        // an OpenDML (>1 GB) file limits to its first RIFF segment.
        if (scale && rate && length) info.durationSec = length * scale / rate;
        info.handler = asciiAt(bytes, body + 4, 4);
      } else if (id === 'strf' && info.handler != null && body + 20 <= bytes.length) {
        var comp = asciiAt(bytes, body + 16, 4).toUpperCase();
        var handler = info.handler.toUpperCase();
        info.fourcc = AVI_FOURCC_MAP[comp] || AVI_FOURCC_MAP[handler] || comp.trim().toLowerCase() || null;
        return true;
      }
      p = body + size + (size & 1);
    }
    return false;
  }

  walk(12, bytes.length);
  delete info.handler;
  if (!info.durationSec) info.durationSec = avihSecs;
  return info;
}

// PAT (PID 0) names the PMT's PID, and the PMT lists each stream's type. Both
// tables fit in a single packet in practice, so sections are not reassembled.
function sniffMpegTs(bytes, packetSize, syncOffset) {
  var info = { container: 'mpegts', fourcc: null, durationSec: null };
  var pmtPid = null;
  for (var p = syncOffset; p + 188 <= bytes.length; p += packetSize) {
    if (bytes[p] !== 0x47) break;
    var pusi = bytes[p + 1] & 0x40;
    var pid = ((bytes[p + 1] & 0x1F) << 8) | bytes[p + 2];
    var afc = (bytes[p + 3] >> 4) & 3;
    if (!pusi || !(afc & 1)) continue;
    var q = p + 4;
    if (afc & 2) q += 1 + bytes[q];
    q += 1 + bytes[q]; // pointer_field
    if (q + 3 > p + 188) continue;
    var sectionLen = ((bytes[q + 1] & 0x0F) << 8) | bytes[q + 2];
    var sectionEnd = Math.min(q + 3 + sectionLen - 4, p + 188); // minus CRC
    if (pid === 0 && bytes[q] === 0x00) {
      for (var r = q + 8; r + 4 <= sectionEnd; r += 4) {
        var program = (bytes[r] << 8) | bytes[r + 1];
        if (program !== 0) { pmtPid = ((bytes[r + 2] & 0x1F) << 8) | bytes[r + 3]; break; }
      }
    } else if (pmtPid != null && pid === pmtPid && bytes[q] === 0x02) {
      var progInfoLen = ((bytes[q + 10] & 0x0F) << 8) | bytes[q + 11];
      for (var e = q + 12 + progInfoLen; e + 5 <= sectionEnd;) {
        var codec = TS_STREAM_TYPES[bytes[e]];
        if (codec) { info.fourcc = codec; return info; }
        e += 5 + (((bytes[e + 3] & 0x0F) << 8) | bytes[e + 4]);
      }
      return info;
    }
  }
  return info;
}

// EBML is a tree of variable-length elements, but the two values needed here
// are short strings with one-byte IDs and sizes, so a byte scan is exact
// enough: DocType (0x4282) separates WebM from Matroska, and the first video
// CodecID (0x86) names the codec.
function sniffMatroska(bytes) {
  var info = { container: 'mkv', fourcc: null, durationSec: null };
  for (var i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0x42 && bytes[i + 1] === 0x82 && (bytes[i + 2] & 0x80)) {
      if (asciiAt(bytes, i + 3, bytes[i + 2] & 0x7F) === 'webm') return null;
      break;
    }
  }
  for (var j = 0; j + 2 < bytes.length; j++) {
    if (bytes[j] !== 0x86 || !(bytes[j + 1] & 0x80)) continue;
    var id = asciiAt(bytes, j + 2, bytes[j + 1] & 0x7F);
    if (id.indexOf('V_') !== 0) continue;
    for (var k = 0; k < MKV_CODEC_IDS.length; k++) {
      if (id.indexOf(MKV_CODEC_IDS[k][0]) === 0) { info.fourcc = MKV_CODEC_IDS[k][1]; break; }
    }
    break;
  }
  return info;
}

// { container, fourcc, codecName, durationSec } for AVI, MPEG-TS and Matroska,
// or null for anything else (MP4/MOV/WebM, or unreadable). fourcc and
// durationSec are null when the header does not say.
function sniffContainer(file) {
  return readFileBytes(file, 0, CONTAINER_SNIFF_BYTES).then(function(b) {
    var info = null;
    if (asciiAt(b, 0, 4) === 'RIFF' && asciiAt(b, 8, 4) === 'AVI ') {
      info = sniffAvi(b);
    } else if (b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) {
      info = sniffMpegTs(b, 188, 0);
    } else if (b[4] === 0x47 && b[196] === 0x47 && b[388] === 0x47) {
      info = sniffMpegTs(b, 192, 4); // .m2ts: 4-byte timestamp before each packet
    } else if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) {
      info = sniffMatroska(b);
    }
    if (info) info.codecName = info.fourcc ? (VIDEO_CODEC_NAMES[info.fourcc] || info.fourcc.toUpperCase()) : null;
    return info;
  }).catch(function() { return null; });
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

  Promise.all([
    sniffVideoTrackFourcc(file).catch(function() { return null; }),
    sniffContainer(file),
  ]).then(function(r) {
    var fourcc = r[0];
    var container = r[1];
    console.warn('[FlySight] video load failed', {
      file: file.name, type: file.type, size: file.size, fourcc: fourcc,
      container: container,
      mediaError: mediaError ? { code: mediaError.code, message: mediaError.message } : null,
    });

    // An .mkv the browser would not play: the container is the problem, so
    // the same path as AVI and MPEG-TS.
    if (container) {
      offerContainerConvert(file, container);
      return;
    }

    // ffmpeg.wasm can decode what the browser cannot, so offer an in-place
    // conversion rather than an alert the user has to act on elsewhere.
    // See scripts/convert.js (not available on file:// origins).
    if (typeof canOfferVideoConvert === 'function' && canOfferVideoConvert(fourcc)) {
      showVideoConvertOffer(file, { fourcc: fourcc, codecName: VIDEO_CODEC_NAMES[fourcc] });
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

// Offers the converter for a container no browser opens, or, where it cannot
// run (file://), explains how to convert the file by hand.
function offerContainerConvert(file, info) {
  if (typeof canOfferVideoConvert === 'function' && canOfferVideoConvert(info.fourcc, info.container)) {
    showVideoConvertOffer(file, info);
    return;
  }
  alert(t('video.errLoadContainer', {
    container: CONTAINER_NAMES[info.container],
    codec: info.codecName || '?',
    name: file.name,
  }));
}

// .lrv (GoPro) and .lrf (DJI) are low-resolution MP4 proxies under another name.
var VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|lrv|lrf|avi|mts|m2ts|ts|mkv)$/i;
// Bumped per drop, so a sniff that finishes after a newer drop is ignored.
var videoDropSeq = 0;

function handleVideoFile(file) {
  const isVideoMime = (file.type || '').toLowerCase().startsWith('video/');
  const isVideoExt = VIDEO_EXT_RE.test(file.name);
  if (!isVideoMime && !isVideoExt) {
    alert(t('video.errDropVideo'));
    return;
  }
  // A previous drop may have left the codec-conversion offer up.
  if (typeof hideVideoConvertOffer === 'function') hideVideoConvertOffer();

  // AVI and MPEG-TS never play in a <video> element, so do not make the user
  // wait for a load that is certain to fail. Matroska is tried natively.
  const seq = ++videoDropSeq;
  sniffContainer(file).then(function(container) {
    if (seq !== videoDropSeq) return;
    if (!document.getElementById('videoModal').classList.contains('open')) return;
    if (container && container.container !== 'mkv') {
      offerContainerConvert(file, container);
      return;
    }
    loadVideoIntoPreview(file);
  });
}

function loadVideoIntoPreview(file) {
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
  const objectURL = state.videoObjectURL;
  video.addEventListener('loadedmetadata', function onMeta() {
    video.removeEventListener('loadedmetadata', onMeta);
    // A load that failed outright never reached this listener, so it is still
    // attached when the next file loads. Without this guard it would probe
    // that file too and report a failure under the old file's name.
    if (state.videoObjectURL !== objectURL) return;
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
      document.getElementById('videoStep1').style.display = 'none';
      document.getElementById('videoStep2').style.display = 'block';
      // Reset exit; the crop covers the whole video until the exit is marked.
      state.videoExitTime = null;
      state.videoCropStart = 0;
      state.videoCropEnd = video.duration;
      document.getElementById('videoExitTimecode').textContent = t('video.notSet');
      state.videoStep = 1;
      refreshVideoSteps();
      // Redraw — by now any in-flight restore has likely landed, and even if not,
      // drawOverlayPreview will re-fire from the loadeddata listener.
      drawOverlayPreview();
      // Start playing straight away so finding the exit is just a matter of
      // pausing on it. The preview is muted, so browsers allow the autoplay;
      // if one refuses anyway the button simply stays on "Play".
      video.play().catch(() => {});
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

// Playback controls. The button is icon-only with a fixed width, so the
// timeline beside it doesn't shift when it flips; the label lives in aria-label.
function setVideoPlayButton(playing) {
  const btn = document.getElementById('videoPlayBtn');
  if (!btn) return;
  btn.classList.toggle('playing', playing);
  btn.setAttribute('aria-label', playing ? t('video.pause') : t('video.play'));
}

function toggleVideoPlay() {
  const v = document.getElementById('videoPreview');
  if (v.paused) {
    // In step 3 playback stays inside the export crop.
    if (isVideoCropping() && (v.currentTime < state.videoCropStart || v.currentTime >= state.videoCropEnd - 0.05)) {
      v.currentTime = state.videoCropStart;
    }
    v.play().catch(() => {});
  } else {
    v.pause();
  }
}

// ── Timeline + export crop ──
// The default crop, set when the exit is marked: CROP_LEAD_SEC before exit
// through CROP_TAIL_SEC after the score appears (the end of the performance
// window), falling back to canopy for an unscorable jump.
const CROP_LEAD_SEC = 5;
const CROP_TAIL_SEC = 5;
const CROP_MIN_SEC = 0.5;
const CROP_SNAP_PX = 8;

function isVideoCropping() {
  return state.videoStep === 3 && state.videoExitTime !== null && state.videoCropEnd !== null;
}

// Exit, score and canopy in video time, for the markers and snapping.
function videoTimelineMarkers() {
  const video = document.getElementById('videoPreview');
  const fd = state.currentFlightData;
  if (state.videoExitTime === null || !fd || !(video.duration > 0)) return [];
  const exit = state.videoExitTime;
  const list = [{ key: 'exit', t: exit, label: t('map.exit') }];
  if (Number.isFinite(fd.perfWindowEndTime)) list.push({ key: 'score', t: exit + fd.perfWindowEndTime, label: t('widget.score') });
  if (Number.isFinite(fd.canopyTimeRel)) list.push({ key: 'canopy', t: exit + fd.canopyTimeRel, label: t('map.canopy') });
  if (Number.isFinite(fd.landingTimeRel)) list.push({ key: 'landing', t: exit + fd.landingTimeRel, label: t('map.landing') });
  return list.filter(m => m.t >= 0 && m.t <= video.duration);
}

// The crop must always contain the exit through the moment the score appears:
// the start can't move past the exit, the end can't move before the score
// (before the exit for an unscorable jump). Both are clamped to the video.
function videoCropLimits() {
  const video = document.getElementById('videoPreview');
  const dur = video.duration || 0;
  const exit = state.videoExitTime;
  if (exit === null) return { startMax: dur, endMin: 0 };
  const fd = state.currentFlightData;
  const scoreT = fd && Number.isFinite(fd.perfWindowEndTime) ? exit + fd.perfWindowEndTime : exit;
  return { startMax: Math.min(dur, exit), endMin: Math.min(dur, Math.max(0, scoreT)) };
}

function setDefaultVideoCrop() {
  const video = document.getElementById('videoPreview');
  const fd = state.currentFlightData;
  const dur = video.duration;
  const exit = state.videoExitTime;
  let endRel = null;
  if (fd && Number.isFinite(fd.perfWindowEndTime)) endRel = fd.perfWindowEndTime + CROP_TAIL_SEC;
  else if (fd && Number.isFinite(fd.canopyTimeRel)) endRel = fd.canopyTimeRel;
  const start = Math.max(0, exit - CROP_LEAD_SEC);
  const end = endRel === null ? dur : Math.min(dur, exit + endRel);
  if (end - start < CROP_MIN_SEC) { state.videoCropStart = 0; state.videoCropEnd = dur; return; }
  state.videoCropStart = start;
  state.videoCropEnd = end;
}

// Positions the playhead, handles and dimmed ends. Pass rebuildMarkers when
// the exit, the jump, the language or the timeline width may have changed.
function renderVideoTimeline(rebuildMarkers) {
  const tl = document.getElementById('videoTimeline');
  const video = document.getElementById('videoPreview');
  if (!tl) return;
  const dur = video.duration > 0 ? video.duration : 0;
  const pct = s => (dur ? Math.min(100, Math.max(0, s / dur * 100)) : 0) + '%';
  const cropping = isVideoCropping();
  tl.classList.toggle('cropping', cropping);
  document.getElementById('vtPlayhead').style.left = pct(video.currentTime || 0);

  if (state.videoCropEnd !== null) {
    const s = state.videoCropStart, e = state.videoCropEnd;
    const hs = document.getElementById('vtHandleStart');
    const he = document.getElementById('vtHandleEnd');
    hs.style.left = pct(s);
    he.style.left = pct(e);
    hs.setAttribute('aria-valuetext', formatVideoTimecode(s));
    he.setAttribute('aria-valuetext', formatVideoTimecode(e));
    const sel = document.getElementById('vtSel');
    sel.style.left = pct(s);
    sel.style.width = (dur ? (e - s) / dur * 100 : 0) + '%';
    document.getElementById('vtDimStart').style.width = pct(s);
    document.getElementById('vtDimEnd').style.width = (dur ? (dur - e) / dur * 100 : 0) + '%';
    const rangeEl = document.getElementById('exportRangeText');
    if (rangeEl) rangeEl.textContent = formatVideoTimecode(s) + ' – ' + formatVideoTimecode(e) + ' (' + (e - s).toFixed(1) + ' s)';
    // Bitrate is a target, so the size is an estimate.
    const sizeEl = document.getElementById('exportSizeText');
    if (sizeEl) sizeEl.textContent = '≈ ' + Math.max(1, Math.round((e - s) * EXPORT_BITRATE / 8 / 1e6)) + ' MB';
  }

  if (!rebuildMarkers) return;
  const wrap = document.getElementById('vtMarkers');
  wrap.innerHTML = '';
  // The fastest 3 s as a green band, matching the chart's scoring zone.
  const fd = state.currentFlightData;
  if (dur && state.videoExitTime !== null && fd && Number.isFinite(fd.best3sStart) && Number.isFinite(fd.best3sEnd)) {
    const zs = state.videoExitTime + fd.best3sStart, ze = state.videoExitTime + fd.best3sEnd;
    if (ze > 0 && zs < dur) {
      const zone = document.createElement('div');
      zone.className = 'vt-zone';
      zone.style.left = pct(zs);
      zone.style.width = (Math.min(ze, dur) - Math.max(zs, 0)) / dur * 100 + '%';
      wrap.append(zone);
    }
  }
  const labels = [];
  for (const m of videoTimelineMarkers()) {
    const tick = document.createElement('div');
    tick.className = 'vt-marker ' + m.key;
    tick.style.left = pct(m.t);
    const label = document.createElement('div');
    label.className = 'vt-marker-label ' + m.key;
    label.style.left = pct(m.t);
    label.textContent = m.label;
    wrap.append(tick, label);
    labels.push(label);
  }
  // On a long video the markers sit close together; drop a label that would
  // overlap the one before it rather than print them on top of each other.
  let lastRight = -Infinity;
  for (const label of labels) {
    const r = label.getBoundingClientRect();
    if (r.width && r.left < lastRight + 4) { label.style.visibility = 'hidden'; continue; }
    lastRight = r.right;
  }
}

(function() {
  const video = document.getElementById('videoPreview');
  const tl = document.getElementById('videoTimeline');
  const handleStart = document.getElementById('vtHandleStart');
  const handleEnd = document.getElementById('vtHandleEnd');

  video.addEventListener('timeupdate', () => {
    document.getElementById('videoTimecode').textContent = formatVideoTimecode(video.currentTime);
    renderVideoTimeline();
    drawOverlayPreview();
  });
  video.addEventListener('play', () => { setVideoPlayButton(true); requestAnimationFrame(followPlayback); });
  video.addEventListener('pause', () => setVideoPlayButton(false));
  video.addEventListener('ended', () => setVideoPlayButton(false));

  // timeupdate fires only a few times a second: too coarse to stop on the crop
  // end, and the playhead would step. Follow playback per frame instead.
  function followPlayback() {
    if (video.paused) return;
    if (isVideoCropping() && !state.videoExporting && video.currentTime >= state.videoCropEnd) {
      video.pause();
      video.currentTime = state.videoCropEnd;
    }
    renderVideoTimeline();
    requestAnimationFrame(followPlayback);
  }

  function timeAt(clientX) {
    const r = tl.getBoundingClientRect();
    const dur = video.duration || 0;
    return Math.min(dur, Math.max(0, (clientX - r.left) / r.width * dur));
  }
  function snapTime(t) {
    const dur = video.duration || 0;
    const tol = CROP_SNAP_PX / tl.getBoundingClientRect().width * dur;
    const targets = [0, dur];
    for (const m of videoTimelineMarkers()) targets.push(m.t);
    if (state.videoExitTime !== null) targets.push(state.videoExitTime - CROP_LEAD_SEC);
    const fd = state.currentFlightData;
    if (state.videoExitTime !== null && fd && Number.isFinite(fd.perfWindowEndTime)) {
      targets.push(state.videoExitTime + fd.perfWindowEndTime + CROP_TAIL_SEC);
    }
    let best = t, bestDiff = tol;
    for (const s of targets) {
      const d = Math.abs(s - t);
      if (d < bestDiff) { best = s; bestDiff = d; }
    }
    return best;
  }
  function setCropEdge(which, t) {
    const dur = video.duration || 0;
    const lim = videoCropLimits();
    if (which === 'start') state.videoCropStart = Math.max(0, Math.min(t, lim.startMax, state.videoCropEnd - CROP_MIN_SEC));
    else state.videoCropEnd = Math.min(dur, Math.max(t, lim.endMin, state.videoCropStart + CROP_MIN_SEC));
    // Show the frame at the edge being moved, so it can be placed by eye.
    if (!video.paused) video.pause();
    video.currentTime = which === 'start' ? state.videoCropStart : state.videoCropEnd;
    renderVideoTimeline();
  }
  function seekTo(t) {
    if (isVideoCropping()) t = Math.min(state.videoCropEnd, Math.max(state.videoCropStart, t));
    video.currentTime = t;
    renderVideoTimeline();
  }

  function drag(el, onMove) {
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || !(video.duration > 0)) return;
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      onMove(e.clientX);
      const move = ev => onMove(ev.clientX);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }
  drag(handleStart, x => setCropEdge('start', snapTime(timeAt(x))));
  drag(handleEnd, x => setCropEdge('end', snapTime(timeAt(x))));
  drag(tl, x => seekTo(timeAt(x)));

  // Arrow keys nudge a focused handle by 0.1 s, or 1 s with Shift.
  for (const [el, which] of [[handleStart, 'start'], [handleEnd, 'end']]) {
    el.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1);
      const cur = which === 'start' ? state.videoCropStart : state.videoCropEnd;
      setCropEdge(which, cur + step);
    });
  }

  if (typeof ResizeObserver === 'function') {
    let lastW = 0;
    new ResizeObserver(() => {
      const w = tl.clientWidth;
      if (w && w !== lastW) { lastW = w; renderVideoTimeline(true); }
    }).observe(tl);
  }
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
  // (Re)marking the exit moves every marker, so the crop resets to the default.
  setDefaultVideoCrop();
  setVideoStep(2); // also redraws, now with the widgets visible
}

// ── Step cards ──
// The right column holds three stacked cards; only state.videoStep's is open.
// Steps 2 and 3 need the exit to be marked, so their headers are disabled
// until then.
function setVideoStep(n) {
  if (n > 1 && state.videoExitTime === null) return;
  state.videoStep = n;
  // Widgets are edited in card 2; leaving it drops the selection so the
  // handles and the settings panel under the timeline don't linger.
  if (n !== 2) {
    state.selectedWidgetId = null;
    state.widgetDragState = null;
  }
  updateWidgetSettingsPanel(); // also calls refreshVideoSteps()
  drawOverlayPreview();
}

function refreshVideoSteps() {
  const exitSet = state.videoExitTime !== null;
  if (!exitSet) state.videoStep = 1;
  const count = state.widgets.length;
  const meta = {
    1: exitSet ? t('video.exitAt', { time: formatVideoTimecode(state.videoExitTime) }) : '',
    2: !exitSet ? t('video.stepLocked') : count ? t('video.widgetCount', { count: count }) : '',
    3: !exitSet ? t('video.stepLocked') : ''
  };
  const done = { 1: exitSet, 2: exitSet && count > 0, 3: false };
  for (let n = 1; n <= 3; n++) {
    const card = document.getElementById('videoStepCard' + n);
    if (!card) continue;
    const active = state.videoStep === n;
    const locked = n > 1 && !exitSet;
    card.classList.toggle('active', active);
    card.classList.toggle('done', done[n] && !active);
    card.classList.toggle('locked', locked);
    const head = card.querySelector('.video-step-head');
    head.disabled = locked;
    head.setAttribute('aria-expanded', active ? 'true' : 'false');
    card.querySelector('.video-step-num').textContent = String(n);
    card.querySelector('.video-step-meta').textContent = active ? '' : meta[n];
  }
  renderVideoTimeline(true);
  refreshExportFormatInfo();
}

// Resolution and format rows in card 3. Reliable mode probes WebCodecs, which
// is async, so the result is cached per frame size; exportFormatSeq drops a stale
// probe that resolves after a newer refresh.
let exportFormatSeq = 0;
const webCodecsPickCache = new Map();
function refreshExportFormatInfo() {
  const video = document.getElementById('videoPreview');
  const resEl = document.getElementById('exportResText');
  const fmtEl = document.getElementById('exportFormatText');
  if (!resEl || !fmtEl) return;
  const w = video.videoWidth, h = video.videoHeight;
  resEl.textContent = w && h ? w + ' × ' + h : '';
  const tail = ', ' + EXPORT_FPS + ' fps, ' + t('video.noAudio');
  const seq = ++exportFormatSeq;
  const reliable = document.getElementById('reliableModeToggle');
  const webCodecs = typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';
  if (!(reliable && reliable.checked && webCodecs && w && h)) {
    fmtEl.textContent = realtimeExportFormat().label + tail;
    return;
  }
  const key = w + 'x' + h;
  if (!webCodecsPickCache.has(key)) webCodecsPickCache.set(key, pickWebCodecsCodec(w, h));
  webCodecsPickCache.get(key).then(pick => {
    if (seq !== exportFormatSeq) return;
    const label = !pick ? realtimeExportFormat().label : pick.container === 'mp4' ? 'MP4 (H.264)' : 'WebM (VP9)';
    fmtEl.textContent = label + tail;
  });
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
  toggle.addEventListener('change', () => {
    setReliableExportPref(toggle.checked);
    refreshExportFormatInfo();
  });
})();

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

// Seek a (paused) video to t and resolve once the frame is decoded. A slow CPU
// can need many seconds per seek on long-GOP footage, so one slow frame must not
// kill the export: each attempt gets SEEK_ATTEMPT_MS of *visible* time (a hidden
// tab doesn't count), then the seek is re-issued, up to SEEK_ATTEMPTS times.
// A poll runs alongside the 'seeked' listener in case the event is missed.
// opts.onSlow fires once per call after SEEK_SLOW_MS; opts.isCancelled resolves
// early so Cancel doesn't wait out a retry.
const SEEK_ATTEMPT_MS = 10000;
const SEEK_ATTEMPTS = 3;
const SEEK_SLOW_MS = 3000;
const SEEK_POLL_MS = 200;
function seekVideoTo(video, t, opts) {
  const onSlow = opts && opts.onSlow;
  const isCancelled = opts && opts.isCancelled;
  return new Promise((resolve, reject) => {
    let done = false;
    let attempt = 1;
    let waited = 0;       // visible ms in the current attempt
    let totalWaited = 0;  // visible ms across all attempts
    let slowFired = false;
    let lastTick = performance.now();
    function cleanup() { clearInterval(poll); video.removeEventListener('seeked', onSeeked); }
    function finish() { if (done) return; done = true; cleanup(); resolve(); }
    function onSeeked() { finish(); }
    function arrived() {
      return !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.02;
    }
    const poll = setInterval(() => {
      if (done) return;
      const now = performance.now();
      if (!document.hidden) { waited += now - lastTick; totalWaited += now - lastTick; }
      lastTick = now;
      if ((isCancelled && isCancelled()) || arrived()) { finish(); return; }
      if (!slowFired && onSlow && totalWaited > SEEK_SLOW_MS) { slowFired = true; onSlow(); }
      if (waited < SEEK_ATTEMPT_MS) return;
      if (attempt >= SEEK_ATTEMPTS) {
        done = true; cleanup();
        reject(new Error('Timed out seeking the video (decode too slow or file unreadable).'));
        return;
      }
      attempt++;
      waited = 0;
      // Nudge so the browser can't treat the re-issued seek as a no-op.
      video.currentTime = t + (attempt % 2 === 0 ? 1e-3 : 0);
    }, SEEK_POLL_MS);
    video.addEventListener('seeked', onSeeked);
    if (Math.abs(video.currentTime - t) < 1e-4) { finish(); return; }
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

  // Export exactly the crop chosen on the timeline in step 3.
  if (state.videoCropEnd === null) setDefaultVideoCrop();
  const trimStart = Math.max(0, state.videoCropStart);
  const trimEnd = Math.min(video.duration, state.videoCropEnd);

  state.videoExporting = true;

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
    state.videoExporting = false;
    setVideoPlayButton(!video.paused);
    modalBody.style.pointerEvents = '';
    modalBody.style.opacity = '';
  }
  function setProgress(pct, label) {
    fillEl.style.width = Math.min(Math.max(pct, 0), 100) + '%';
    textEl.textContent = label;
  }
  function finishExport(blob, fileExt) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.currentJumpName.replace(/\.[^.]+$/, '') + '_overlay' + fileExt;  // suffix kept untranslated for stable filenames
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    restoreUI();
  }
  function failExport(message) {
    try { if (!video.paused) video.pause(); } catch {}
    restoreUI();
    alert(message);
  }
  // Cancellation: tear down quietly with no download and no alert.
  function abortExport() {
    try { if (!video.paused) video.pause(); } catch {}
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

// Both export paths render at EXPORT_FPS with a EXPORT_BITRATE target.
const EXPORT_FPS = 30;
const EXPORT_BITRATE = 5_000_000;

// Container the real-time path records into: MP4 where MediaRecorder can
// (Chrome, Edge, Safari), WebM otherwise (Firefox).
function realtimeExportFormat() {
  const ok = type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type);
  if (ok('video/mp4')) return { mimeType: 'video/mp4', fileExt: '.mp4', label: 'MP4' + (ok('video/mp4;codecs=avc1') ? ' (H.264)' : '') };
  if (ok('video/webm;codecs=vp9')) return { mimeType: 'video/webm;codecs=vp9', fileExt: '.webm', label: 'WebM (VP9)' };
  return { mimeType: 'video/webm', fileExt: '.webm', label: 'WebM' };
}

// Real-time path: canvas.captureStream + MediaRecorder driven by playback.
// Fast on capable machines; hardened so a decode stall surfaces a message and
// delivers a partial file instead of hanging silently.
function exportRealtime(opts) {
  const { video, canvas, ctx, contentRect, trimStart, trimEnd, setProgress, finishExport, failExport, abortExport } = opts;

  const { mimeType, fileExt } = realtimeExportFormat();

  let stream, recorder;
  try {
    stream = canvas.captureStream(EXPORT_FPS);
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: EXPORT_BITRATE });
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
    // Natural end of a short video (the crop ends at the very end of the
    // footage, and the last frame may never reach trimEnd). Once the
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

// Codec for the reliable path at this frame size, or null when WebCodecs has
// no usable config (the export then falls back to the real-time path).
// Prefer Constrained Baseline H.264 (profile_idc 66 + constraint_set1):
// Baseline forbids B-frames by spec, so the encoder cannot reorder frames.
// High profile (avc1.640028) lets Firefox's encoder emit B-frames, which come
// out in decode order with non-monotonic presentation timestamps that mp4-muxer
// rejects ("DTS must be monotonically increasing"). We try Baseline at
// decreasing levels (5.2 → 4.0 → 3.0) to fit the frame size, and only fall back
// to High if no Baseline level is available. Levels: 34=5.2, 28=4.0, 1f=3.1.
async function pickWebCodecsCodec(width, height) {
  if (typeof window.VideoEncoder !== 'function') return null;
  async function supported(codec) {
    try {
      const s = await window.VideoEncoder.isConfigSupported({ codec, width, height });
      return !!(s && s.supported);
    } catch { return false; }
  }
  if (typeof window.Mp4Muxer !== 'undefined') {
    for (const c of ['avc1.42E034', 'avc1.42E028', 'avc1.42E01F', 'avc1.640028']) {
      if (await supported(c)) return { codec: c, container: 'mp4' };
    }
  }
  if (typeof window.WebMMuxer !== 'undefined' && await supported('vp09.00.10.08')) {
    return { codec: 'vp09.00.10.08', container: 'webm' };
  }
  return null;
}

// Reliable path: WebCodecs VideoEncoder, frame-by-frame. Decoupled from
// real-time playback, so a slow CPU only makes it take longer — it never
// stalls and the output timing is frame-accurate (explicit timestamps).
async function exportWithWebCodecs(opts) {
  const { video, canvas, ctx, contentRect, trimStart, trimEnd, setProgress, finishExport, failExport, abortExport } = opts;

  const FPS = EXPORT_FPS;
  const width = canvas.width;
  const height = canvas.height;

  try {
    let muxer, target, codec, fileExt, mimeType;

    const pick = await pickWebCodecsCodec(width, height);
    const h264Codec = pick && pick.container === 'mp4' ? pick.codec : null;
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
    } else if (pick && pick.container === 'webm') {
      codec = pick.codec;
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
    encoder.configure({ codec, width, height, bitrate: EXPORT_BITRATE, framerate: FPS, latencyMode: 'realtime' });

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
      // there, which would otherwise time out (e.g. a crop that runs to the end
      // of the video, so trimEnd is video.duration).
      // Not named `t` — that's the global translation function, used below.
      const seekTime = Math.min(trimStart + i / FPS, trimEnd, Math.max(0, video.duration - 0.01));
      await seekVideoTo(video, seekTime, {
        onSlow: () => setProgress((i / totalFrames) * 100, t('video.seekSlow')),
        isCancelled: () => cancelled,
      });
      if (cancelled) break;

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
