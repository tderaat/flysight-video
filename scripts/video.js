
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
  state.videoFileName = null;
  state.videoFile = null;
  state.videoSourceFps = null;
  state.videoHasAudio = null;

  state.videoExitTime = null;
  state.videoCropStart = null;
  state.videoCropEnd = null;
  document.getElementById('videoExitTimecode').textContent = '';
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

// Child boxes of an ISO-BMFF container box, as { type, start, end } over the
// box bodies (start is past the header).
function mp4ChildBoxes(bytes, start, end) {
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var out = [];
  var p = start;
  while (p + 8 <= end) {
    var size = dv.getUint32(p);
    var header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push({ type: fourccAt(bytes, p + 4), start: p + header, end: p + size });
    p += size;
  }
  return out;
}

// What the browser does not tell us about an MP4/MOV: the video track's
// frame rate (from mdhd's timescale over stts's sample durations), its stored
// size (from the stsd sample entry, which also works on a file the browser
// cannot decode) and whether there is a sound track at all. Resolves to
// { width, height, fps, hasAudio } with null for anything unreadable, or null
// for a file that is not ISO-BMFF.
function readMp4TrackInfo(file) {
  return readMoovBytes(file).then(function(moov) {
    if (!moov) return null;
    var dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
    var child = function(box, type) {
      return mp4ChildBoxes(moov, box.start, box.end).find(function(b) { return b.type === type; }) || null;
    };
    var info = { width: null, height: null, fps: null, hasAudio: false };
    var traks = mp4ChildBoxes(moov, 0, moov.length).filter(function(b) { return b.type === 'trak'; });
    for (var i = 0; i < traks.length; i++) {
      var mdia = child(traks[i], 'mdia');
      var hdlr = mdia && child(mdia, 'hdlr');
      if (!hdlr || hdlr.start + 12 > hdlr.end) continue;
      var handler = fourccAt(moov, hdlr.start + 8);
      if (handler === 'soun') { info.hasAudio = true; continue; }
      if (handler !== 'vide' || info.width) continue;
      var stbl = child(mdia, 'minf');
      stbl = stbl && child(stbl, 'stbl');
      var stsd = stbl && child(stbl, 'stsd');
      // stsd body: version/flags (4), entry_count (4), then the sample entry:
      // size + fourcc (8), 24 bytes of VisualSampleEntry fields, width, height.
      if (stsd && stsd.start + 44 <= stsd.end) {
        info.width = dv.getUint16(stsd.start + 40);
        info.height = dv.getUint16(stsd.start + 42);
      }
      var mdhd = child(mdia, 'mdhd');
      var stts = stbl && child(stbl, 'stts');
      if (mdhd && stts && stts.start + 8 <= stts.end) {
        var timescale = dv.getUint32(mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));
        var entries = dv.getUint32(stts.start + 4);
        var samples = 0, ticks = 0;
        for (var e = 0, p = stts.start + 8; e < entries && p + 8 <= stts.end; e++, p += 8) {
          var count = dv.getUint32(p);
          samples += count;
          ticks += count * dv.getUint32(p + 4);
        }
        if (timescale && samples && ticks) {
          var fps = timescale * samples / ticks;
          if (fps > 1 && fps < 1000) info.fps = fps;
        }
      }
    }
    return info;
  }).catch(function() { return null; });
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
        // BITMAPINFOHEADER biWidth / biHeight; a negative height means top-down.
        info.width = Math.abs(dv.getInt32(body + 4, true)) || null;
        info.height = Math.abs(dv.getInt32(body + 8, true)) || null;
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

// opts.keepSync: the file is a converted copy of the one already loaded (same
// timeline), so the marked exit, the crop and the open step are kept.
function loadVideoIntoPreview(file, opts) {
  const keepSync = !!(opts && opts.keepSync) && state.videoExitTime !== null;
  const kept = keepSync
    ? { exit: state.videoExitTime, cropStart: state.videoCropStart, cropEnd: state.videoCropEnd, step: state.videoStep }
    : null;
  if (state.videoObjectURL) URL.revokeObjectURL(state.videoObjectURL);
  state.videoObjectURL = URL.createObjectURL(file);
  state.videoFileName = file.name;
  state.videoFile = file;
  // Filled in below from the file's own headers; null means unknown.
  state.videoSourceFps = null;
  state.videoHasAudio = null;
  const video = document.getElementById('videoPreview');
  readMp4TrackInfo(file).then(info => {
    if (state.videoFile !== file || !info) return;
    if (info.fps) state.videoSourceFps = info.fps;
    state.videoHasAudio = info.hasAudio;
    refreshExportFormatInfo();
  });

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

      document.getElementById('videoDuration').textContent = '/ ' + formatVideoTimecode(video.duration);
      document.getElementById('videoStep1').style.display = 'none';
      document.getElementById('videoStep2').style.display = 'block';
      if (kept) {
        state.videoExitTime = kept.exit;
        state.videoCropStart = Math.min(kept.cropStart, video.duration);
        state.videoCropEnd = Math.min(kept.cropEnd, video.duration);
        document.getElementById('videoExitTimecode').textContent = formatVideoTimecode(kept.exit);
        state.videoStep = kept.step;
        video.currentTime = kept.exit;
      } else {
        video.currentTime = 0;
        // Reset exit; the crop covers the whole video until the exit is marked.
        state.videoExitTime = null;
        state.videoCropStart = 0;
        state.videoCropEnd = video.duration;
        document.getElementById('videoExitTimecode').textContent = '';
        state.videoStep = 1;
      }
      refreshVideoSteps();
      renderVideoTimeline(true);
      // Redraw — by now any in-flight restore has likely landed, and even if not,
      // drawOverlayPreview will re-fire from the loadeddata listener.
      drawOverlayPreview();
      // Above 1080p, offer a smaller copy: decoding 4K is what makes scrubbing
      // and exporting slow. Not for our own converted output.
      if (Math.min(video.videoWidth, video.videoHeight) > EXPORT_RES_AUTO_CAP && !file.flysightConverted &&
          typeof showVideoHiresOffer === 'function') {
        showVideoHiresOffer(file, video.videoWidth, video.videoHeight);
      }
      measureSourceFps(video, file);
      // Start playing straight away so finding the exit is just a matter of
      // pausing on it. The preview is muted, so browsers allow the autoplay;
      // if one refuses anyway the button simply stays on "Play".
      if (!kept) video.play().catch(() => {});
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
    renderExportSize();
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
  // The export step is about setting the range, so playback stops there.
  const video = document.getElementById('videoPreview');
  if (n === 3 && !video.paused) video.pause();
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

// The settings rows in card 3 (resolution, frame rate, quality, audio) and the
// format and size lines they produce. The format comes from probing WebCodecs,
// which is async, so the result is cached per frame size; exportFormatSeq
// drops a stale probe that resolves after a newer refresh.
let exportFormatSeq = 0;
const webCodecsPickCache = new Map();
const webCodecsAudioCache = new Map();
function refreshExportFormatInfo() {
  const video = document.getElementById('videoPreview');
  const fmtEl = document.getElementById('exportFormatText');
  if (!fmtEl) return;
  renderExportResSelect(video.videoWidth, video.videoHeight);
  renderExportFpsSelect();
  renderExportAudioToggle();
  // The probe and the label describe the output, which may be scaled down.
  const { width: w, height: h } = exportOutputSize(video);
  renderExportQualitySelect(w, h);
  renderExportSize();
  const wantAudio = exportWantsAudio();
  const seq = ++exportFormatSeq;
  if (!w || !h) { fmtEl.textContent = ''; return; }
  if (getDirectRenderPref()) {
    const f = realtimeExportFormat(wantAudio);
    fmtEl.textContent = f.label + ', ' + (f.audio ? t('video.audioCodec', { codec: f.audio }) : t('video.noAudio'));
    return;
  }
  if (!webCodecsExportAvailable()) { fmtEl.textContent = t('video.formatUnsupported'); return; }
  const key = w + 'x' + h;
  if (!webCodecsPickCache.has(key)) webCodecsPickCache.set(key, pickWebCodecsCodec(w, h));
  webCodecsPickCache.get(key).then(pick => {
    if (!pick) return null;
    if (!wantAudio) return { pick, audio: null };
    if (!webCodecsAudioCache.has(pick.container)) webCodecsAudioCache.set(pick.container, pickWebCodecsAudio(pick.container, 2));
    return webCodecsAudioCache.get(pick.container).then(audio => ({ pick, audio }));
  }).then(r => {
    if (seq !== exportFormatSeq) return;
    if (!r) { fmtEl.textContent = t('video.formatUnsupported'); return; }
    const label = r.pick.container === 'mp4' ? 'MP4 (H.264)' : 'WebM (VP9)';
    fmtEl.textContent = label + ', ' + (r.audio ? t('video.audioCodec', { codec: r.audio.label }) : t('video.noAudio'));
  });
}

// The export encodes with WebCodecs and muxes with mp4-muxer or webm-muxer;
// without them this browser cannot export at all.
function webCodecsExportAvailable() {
  return typeof window.VideoEncoder === 'function' &&
    typeof window.VideoFrame === 'function' &&
    (typeof window.Mp4Muxer !== 'undefined' || typeof window.WebMMuxer !== 'undefined');
}

// ── Export resolution ──
// Drawing, holding and encoding every frame at 4K is what exhausts an
// integrated GPU (it shares system RAM), so the export can be scaled down.
// The cap applies to the short side, so a portrait video is handled the same
// way. 'auto' caps at 1080p, so a 4K source exports at 1080p unless the user
// asks for more. Widgets are laid out as fractions of the frame, so they
// scale with it. Persisted in flysight_export_res.
const EXPORT_RES_CAPS = [1080, 720];
const EXPORT_RES_AUTO_CAP = 1080;
function getExportResPref() {
  try { return localStorage.getItem('flysight_export_res') || 'auto'; } catch { return 'auto'; }
}
function setExportResPref(v) {
  try { localStorage.setItem('flysight_export_res', v); } catch {}
}

// Short-side cap 'auto' resolves to for a w×h source, 0 for no scaling.
function autoExportCap(w, h) {
  return Math.min(w, h) > EXPORT_RES_AUTO_CAP ? EXPORT_RES_AUTO_CAP : 0;
}

// Short-side cap for a w×h source under the current setting, 0 for no scaling.
function resolveExportCap(w, h) {
  const pref = getExportResPref();
  if (pref === 'original') return 0;
  if (pref === 'auto') return autoExportCap(w, h);
  const cap = Number(pref);
  return cap && Math.min(w, h) > cap ? cap : 0;
}

// w×h scaled so its short side is cap, rounded to even sizes (H.264 needs them).
function scaleToCap(w, h, cap) {
  const shortSide = Math.min(w, h);
  if (!cap || shortSide <= cap) return { width: w, height: h };
  const k = cap / shortSide;
  const even = n => Math.max(2, Math.round(n * k / 2) * 2);
  return { width: even(w), height: even(h) };
}

function exportOutputSize(video) {
  const w = video.videoWidth, h = video.videoHeight;
  return scaleToCap(w, h, resolveExportCap(w, h));
}

function addSelectOption(sel, value, label) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  sel.appendChild(opt);
}

// Rebuilds the options for this source: auto, original, then each cap below it.
// Automatic is only listed when it differs from Original (a source above
// 1080p); otherwise the two would be the same size twice. The
// stored 'auto' preference is kept either way, so it applies again as soon as
// Automatic means something.
function renderExportResSelect(w, h) {
  const sel = document.getElementById('exportResSelect');
  if (!sel) return;
  sel.innerHTML = '';
  if (!w || !h) { sel.disabled = true; return; }
  sel.disabled = false;
  const dims = size => size.width + ' × ' + size.height;
  if (autoExportCap(w, h)) addSelectOption(sel, 'auto', t('video.resAuto', { res: dims(scaleToCap(w, h, autoExportCap(w, h))) }));
  addSelectOption(sel, 'original', t('video.resOriginal', { res: dims({ width: w, height: h }) }));
  for (const cap of EXPORT_RES_CAPS) {
    if (Math.min(w, h) > cap) addSelectOption(sel, String(cap), cap + 'p (' + dims(scaleToCap(w, h, cap)) + ')');
  }
  // A cap the source is already below exports at the source size.
  const pref = getExportResPref();
  sel.value = sel.querySelector('option[value="' + pref + '"]') ? pref : 'original';
}

// ── Export frame rate ──
// 'original' keeps the source's frame rate (read from the MP4 header, or
// measured during playback), capped at EXPORT_FPS_MAX; '30' halves a 60 fps
// source for a smaller, lighter export. Persisted in flysight_export_fps.
const EXPORT_FPS_DEFAULT = 30;
const EXPORT_FPS_MAX = 60;
function getExportFpsPref() {
  try { return localStorage.getItem('flysight_export_fps') || 'original'; } catch { return 'original'; }
}
function setExportFpsPref(v) {
  try { localStorage.setItem('flysight_export_fps', v); } catch {}
}

// The frame rate an export renders at. An unknown source rate falls back to 30.
function exportFps() {
  const src = state.videoSourceFps;
  if (getExportFpsPref() === '30' || !src) return Math.min(EXPORT_FPS_DEFAULT, src || EXPORT_FPS_DEFAULT);
  return Math.min(src, EXPORT_FPS_MAX);
}

function formatFps(fps) {
  return String(Math.round(fps * 100) / 100);
}

function renderExportFpsSelect() {
  const sel = document.getElementById('exportFpsSelect');
  if (!sel) return;
  const src = state.videoSourceFps;
  sel.innerHTML = '';
  if (!src) addSelectOption(sel, 'original', t('video.fpsOriginalPlain'));
  else if (src > EXPORT_FPS_MAX + 0.5) addSelectOption(sel, 'original', t('video.fpsValue', { fps: EXPORT_FPS_MAX }));
  else addSelectOption(sel, 'original', t('video.fpsOriginal', { fps: formatFps(src) }));
  // A source at 30 fps or below has nothing to halve.
  if (!src || src > EXPORT_FPS_DEFAULT + 0.5) addSelectOption(sel, '30', t('video.fpsValue', { fps: EXPORT_FPS_DEFAULT }));
  const pref = getExportFpsPref();
  sel.value = sel.querySelector('option[value="' + pref + '"]') ? pref : 'original';
}

// A WebM (or a file whose header we cannot read) tells us nothing, so the
// rate is measured from the decoded frames' media times while the preview
// autoplays, then snapped to the nearest common camera rate.
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
function measureSourceFps(video, file) {
  if (!('requestVideoFrameCallback' in video)) return;
  const times = [];
  const onFrame = (now, meta) => {
    if (state.videoFile !== file || state.videoSourceFps) return;
    times.push(meta.mediaTime);
    if (times.length < 16) { video.requestVideoFrameCallback(onFrame); return; }
    const deltas = [];
    for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) deltas.push(times[i] - times[i - 1]);
    if (deltas.length < 8) return;
    deltas.sort((a, b) => a - b);
    const raw = 1 / deltas[Math.floor(deltas.length / 2)];
    const snap = COMMON_FPS.reduce((best, f) => Math.abs(f - raw) < Math.abs(best - raw) ? f : best, COMMON_FPS[0]);
    state.videoSourceFps = Math.abs(snap - raw) / raw < 0.03 ? snap : raw;
    refreshExportFormatInfo();
  };
  video.requestVideoFrameCallback(onFrame);
}

// ── Export quality ──
// Sets the video bitrate. Standard is the long-standing 5 Mbps at 1080p30,
// scaled by pixel count, and sub-linearly by frame rate (consecutive frames at
// 60 fps differ less, so they need less than double). Low halves it, High
// doubles it. Persisted in flysight_export_quality.
const EXPORT_BITRATE_REF = 5_000_000;   // standard at 1920×1080, 30 fps
const EXPORT_QUALITY_MUL = { low: 0.5, standard: 1, high: 2 };
const EXPORT_QUALITIES = ['low', 'standard', 'high'];
const EXPORT_BITRATE_MAX = 80_000_000;
const EXPORT_AUDIO_BITRATE = 128_000;
function getExportQualityPref() {
  try {
    const v = localStorage.getItem('flysight_export_quality');
    return EXPORT_QUALITY_MUL[v] ? v : 'standard';
  } catch { return 'standard'; }
}
function setExportQualityPref(v) {
  try { localStorage.setItem('flysight_export_quality', v); } catch {}
}

// Rounded to 0.5 Mbps, so the label shows a tidy figure that is also exact.
function exportBitrate(w, h, fps, quality) {
  const raw = EXPORT_BITRATE_REF * (w * h) / (1920 * 1080) * Math.pow(fps / 30, 0.7) * EXPORT_QUALITY_MUL[quality];
  return Math.min(EXPORT_BITRATE_MAX, Math.max(500_000, Math.round(raw / 500_000) * 500_000));
}

function formatMbps(bps) {
  return String(Math.round(bps / 1e5) / 10);
}

function renderExportQualitySelect(w, h) {
  const sel = document.getElementById('exportQualitySelect');
  if (!sel) return;
  sel.innerHTML = '';
  const fps = exportFps();
  for (const q of EXPORT_QUALITIES) {
    const label = t('video.quality_' + q) + (w && h ? ' (' + formatMbps(exportBitrate(w, h, fps, q)) + ' Mbps)' : '');
    addSelectOption(sel, q, label);
  }
  sel.value = getExportQualityPref();
}

// ── Export audio ──
// On by default; the checkbox is disabled, with a tooltip, when the source
// has no sound track at all. Persisted in flysight_export_audio.
function getExportAudioPref() {
  try { return localStorage.getItem('flysight_export_audio') !== '0'; } catch { return true; }
}
function setExportAudioPref(on) {
  try { localStorage.setItem('flysight_export_audio', on ? '1' : '0'); } catch {}
}

function exportWantsAudio() {
  return getExportAudioPref() && state.videoHasAudio !== false;
}

function renderExportAudioToggle() {
  const box = document.getElementById('exportAudioToggle');
  if (!box) return;
  const none = state.videoHasAudio === false;
  box.checked = getExportAudioPref() && !none;
  box.disabled = none;
  const cell = box.parentElement;
  if (none) cell.setAttribute('data-tip', t('video.audioNone'));
  else cell.removeAttribute('data-tip');
}

// Bitrates are targets, so the size is an estimate.
function renderExportSize() {
  const sizeEl = document.getElementById('exportSizeText');
  const video = document.getElementById('videoPreview');
  if (!sizeEl || state.videoCropEnd === null || !video.videoWidth) return;
  const { width: w, height: h } = exportOutputSize(video);
  const bps = exportBitrate(w, h, exportFps(), getExportQualityPref()) + (exportWantsAudio() ? EXPORT_AUDIO_BITRATE : 0);
  const secs = state.videoCropEnd - state.videoCropStart;
  sizeEl.textContent = '≈ ' + Math.max(1, Math.round(secs * bps / 8 / 1e6)) + ' MB';
}

// Wires the settings rows: each change is persisted and the rows re-rendered.
(function() {
  const wire = (id, set, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { set(value(el)); refreshExportFormatInfo(); });
  };
  wire('exportResSelect', setExportResPref, el => el.value);
  wire('exportFpsSelect', setExportFpsPref, el => el.value);
  wire('exportQualitySelect', setExportQualityPref, el => el.value);
  wire('exportAudioToggle', setExportAudioPref, el => el.checked);
})();

// ── Failure messages ──
// Every export failure ends with a short "Things to try" list, holding only
// the tips that apply to this export: turning Direct render off (it drops
// frames and stalls on slower machines), a smaller resolution above 720p, the
// 1080p converter for a source above 1080p (decoding 4K is heavy even for a
// smaller export), and closing other tabs when the error points at the
// graphics chip.
const GPU_ERROR_RE = /tainted|gpu|context lost|out of memory|EncodingError|OperationError/i;
function exportFailureTips(width, height, cause, direct) {
  const video = document.getElementById('videoPreview');
  const tips = [];
  if (direct) tips.push(t('video.tipDirectOff'));
  const shortSide = Math.min(width, height);
  if (shortSide > EXPORT_RES_AUTO_CAP) tips.push(t('video.tipRes1080or720'));
  else if (shortSide > 720) tips.push(t('video.tipRes720'));
  if (Math.min(video.videoWidth, video.videoHeight) > EXPORT_RES_AUTO_CAP &&
      typeof canRunVideoConvert === 'function' && canRunVideoConvert()) {
    tips.push(t('video.tipConvert1080'));
  }
  if (cause != null && GPU_ERROR_RE.test(String(cause))) tips.push(t('video.tipCloseTabs'));
  return tips;
}

function withExportTips(message, width, height, cause, direct) {
  const tips = exportFailureTips(width, height, cause, direct);
  if (!tips.length) return message;
  return message + '\n\n' + t('video.tipsTitle') + '\n' + tips.map(s => '• ' + s).join('\n');
}

// ── Export pipeline ──

// Render every placed widget onto ctx for the given flight-data index.
// Used by the export (the on-screen preview keeps its own copy in
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
// How often one frame may reload the video element after a timed-out seek
// before the export gives up.
const SEEK_RELOADS_MAX = 2;
// At most this many frames wait in front of the encoder. Each is a raw
// canvas-sized frame (about 3.5 MB at 720p), and on integrated graphics they
// share the system's memory, so a deep queue costs real RAM for no speed.
const EXPORT_ENCODE_QUEUE_MAX = 8;
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

// Called by the Cancel button (#exportCancelBtn). The running export
// registers its teardown on state.activeExportCancel during startExport.
function cancelExport() {
  if (state.activeExportCancel) state.activeExportCancel();
}

function startExport() {
  if (state.videoExitTime === null) { alert(t('video.errMarkExit')); return; }
  if (!state.currentFlightData) { alert(t('video.errNoFlightData')); return; }
  if (state.widgets.length === 0) { alert(t('video.errNoWidgets')); return; }
  const direct = getDirectRenderPref();
  if (!direct && !webCodecsExportAvailable()) { alert(t('video.errNoWebCodecs')); return; }

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

  // Scaled per the Resolution setting; drawImage() resizes each video frame.
  const outSize = exportOutputSize(video);
  const canvas = document.createElement('canvas');
  canvas.width = outSize.width;
  canvas.height = outSize.height;
  const ctx = canvas.getContext('2d');
  const contentRect = { width: canvas.width, height: canvas.height };
  const fps = exportFps();
  const bitrate = exportBitrate(canvas.width, canvas.height, fps, getExportQualityPref());
  const wantAudio = exportWantsAudio();

  const progressEl = document.getElementById('exportProgress');
  const fillEl = document.getElementById('progressFill');
  const textEl = document.getElementById('progressText');
  const btnEl = document.getElementById('exportBtn');
  const cancelBtnEl = document.getElementById('exportCancelBtn');

  // The export registers a cancel handler here; the Cancel button calls
  // cancelExport(), which invokes it. Reset on every start and cleared by restoreUI.
  state.activeExportCancel = null;
  if (cancelBtnEl) { cancelBtnEl.disabled = false; cancelBtnEl.textContent = t('video.cancel'); }

  function restoreUI() {
    progressEl.style.display = 'none';
    btnEl.disabled = false;
    state.activeExportCancel = null;
    state.videoExporting = false;
    // Direct render unmutes the video to record its sound.
    video.muted = true;
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
  // cause: the underlying error, if any, so a graphics failure gets its tip.
  function failExport(message, cause) {
    try { if (!video.paused) video.pause(); } catch {}
    restoreUI();
    alert(withExportTips(message, canvas.width, canvas.height, cause, direct));
  }
  // Cancellation: tear down quietly with no download and no alert.
  function abortExport() {
    try { if (!video.paused) video.pause(); } catch {}
    restoreUI();
  }

  progressEl.style.display = 'block';
  btnEl.disabled = true;
  setProgress(0, t('video.preparing'));

  const opts = {
    video, canvas, ctx, contentRect, trimStart, trimEnd, fps, bitrate, wantAudio,
    file: state.videoFile, setProgress, finishExport, failExport, abortExport,
  };
  if (direct) {
    // Created here, inside the click, so the browser lets the audio start.
    if (wantAudio) getExportAudioGraph(video);
    exportRealtime(opts);
  } else {
    exportWithWebCodecs(opts);
  }
}

// How often the frame-by-frame time left changes, and how far above the
// measured pace it starts (+25% at the start, shrinking to nothing at the end).
const EXPORT_ETA_REFRESH_MS = 2500;
const EXPORT_ETA_START_MARGIN = 0.25;

// "m:ss" for the time left in the progress line.
function formatExportEta(secs) {
  const s = Math.max(0, Math.round(secs));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// ── Direct render (beta) ──
// Opt-in, for fast machines: records the canvas while the video plays in real
// time (canvas.captureStream + MediaRecorder) instead of seeking frame by
// frame. Much faster where the machine keeps up, but a slow one drops frames
// or stalls, and MediaRecorder loses roughly the first 0.75 s of the range
// while it starts. Persisted in flysight_direct_render ('1'/'0', default off).
function getDirectRenderPref() {
  try { return localStorage.getItem('flysight_direct_render') === '1'; } catch { return false; }
}
function setDirectRenderPref(on) {
  try { localStorage.setItem('flysight_direct_render', on ? '1' : '0'); } catch {}
}

(function() {
  const toggle = document.getElementById('directRenderToggle');
  if (!toggle) return;
  toggle.checked = getDirectRenderPref();
  toggle.addEventListener('change', () => {
    setDirectRenderPref(toggle.checked);
    refreshExportFormatInfo();
  });
})();

// Container Direct render records into: MP4 where MediaRecorder can (Chrome,
// Edge, Safari), WebM otherwise (Firefox). With sound, the first type that
// also takes an audio codec wins; `audio` names that codec, or is null when
// the recording will be silent.
const REALTIME_AUDIO_TYPES = [
  { mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', fileExt: '.mp4', label: 'MP4 (H.264)', audio: 'AAC' },
  { mimeType: 'video/mp4;codecs=avc1,opus', fileExt: '.mp4', label: 'MP4 (H.264)', audio: 'Opus' },
  { mimeType: 'video/webm;codecs=vp9,opus', fileExt: '.webm', label: 'WebM (VP9)', audio: 'Opus' },
  { mimeType: 'video/webm;codecs=vp8,opus', fileExt: '.webm', label: 'WebM (VP8)', audio: 'Opus' },
];
function realtimeExportFormat(withAudio) {
  const ok = type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type);
  if (withAudio) {
    const hit = REALTIME_AUDIO_TYPES.find(f => ok(f.mimeType));
    if (hit) return hit;
  }
  if (ok('video/mp4')) return { mimeType: 'video/mp4', fileExt: '.mp4', label: 'MP4' + (ok('video/mp4;codecs=avc1') ? ' (H.264)' : ''), audio: null };
  if (ok('video/webm;codecs=vp9')) return { mimeType: 'video/webm;codecs=vp9', fileExt: '.webm', label: 'WebM (VP9)', audio: null };
  return { mimeType: 'video/webm', fileExt: '.webm', label: 'WebM', audio: null };
}

// Direct render records the video element's sound through Web Audio:
// element -> MediaStreamAudioDestinationNode -> an audio track added to the
// canvas stream. It is deliberately not connected to the speakers, so the
// export stays silent while the element is unmuted for it. An element can only
// be given one MediaElementSource, so the graph is built once and reused.
let exportAudioGraph = null;
function getExportAudioGraph(video) {
  if (!exportAudioGraph) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const src = ctx.createMediaElementSource(video);
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);
      exportAudioGraph = { ctx, track: dest.stream.getAudioTracks()[0] };
    } catch (e) {
      console.warn('[FlySight] could not route the video sound for export', e);
      return null;
    }
  }
  exportAudioGraph.ctx.resume().catch(() => {});
  return exportAudioGraph;
}

// Hardened so a decode stall surfaces a message and delivers a partial file
// instead of hanging silently.
function exportRealtime(opts) {
  const { video, canvas, ctx, contentRect, trimStart, trimEnd, fps, bitrate, setProgress, finishExport, failExport, abortExport } = opts;

  const graph = opts.wantAudio ? getExportAudioGraph(video) : null;
  const { mimeType, fileExt, audio } = realtimeExportFormat(!!graph);
  const withAudio = !!(graph && audio);

  let stream, recorder;
  try {
    stream = canvas.captureStream(fps);
    if (withAudio) stream.addTrack(graph.track);
    const recOpts = { mimeType, videoBitsPerSecond: bitrate };
    if (withAudio) recOpts.audioBitsPerSecond = EXPORT_AUDIO_BITRATE;
    recorder = new MediaRecorder(stream, recOpts);
  } catch (e) {
    failExport(t('video.errRecorder', { msg: (e && e.message ? e.message : e) }), e);
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
    // footage, and the last frame may never reach trimEnd). Once the video
    // ends, requestVideoFrameCallback stops firing, so renderFrame can't
    // catch this itself; deliver whatever we captured.
    if (finished || aborted) return;
    stopRecording();
  }
  function onVideoError() {
    if (finished || aborted) return;
    aborted = true;
    cleanupListeners();
    try { recorder.stop(); } catch {}
    failExport(t('video.errPlayback'), video.error && video.error.message);
  }

  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onerror = e => {
    if (finished || aborted) return;
    aborted = true;
    cleanupListeners();
    failExport(t('video.errRecording', { msg: (e && e.error && e.error.message ? e.error.message : 'unknown error') }), e && e.error);
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
      alert(withExportTips(t('video.errStalled'), canvas.width, canvas.height, null, true));
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

    // Plays in real time, so the time left is simply what is left of the range.
    const pct = ((video.currentTime - trimStart) / (trimEnd - trimStart)) * 100;
    setProgress(pct, t('video.exportingPctEta', { pct: Math.round(pct), left: formatExportEta(trimEnd - video.currentTime) }));

    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(renderFrame);
    } else {
      requestAnimationFrame(renderFrame);
    }
  }

  // Muted elements feed silence into Web Audio, so the sound needs the
  // element unmuted; restoreUI() mutes it again.
  video.muted = !withAudio;
  seekVideoTo(video, trimStart).then(() => {
    if (aborted) return;
    try { recorder.start(); } catch (e) { failExport(t('video.errRecorderStart', { msg: (e && e.message ? e.message : e) }), e); return; }
    // A pause from Cancel or a stall rejects play(); the watchdog handles both.
    video.play().catch(() => {});
    lastTime = video.currentTime;

    // Watchdog: a stalled (but not "paused") video is the silent-hang case,
    // where requestVideoFrameCallback simply stops firing. Detect no progress
    // and either nudge playback once or stop with whatever we captured.
    watchdog = setInterval(() => {
      if (finished || aborted) return;
      // Reaching trimEnd is the normal finish; if rVFC didn't fire to catch it
      // (e.g. the video ended at exactly trimEnd), stop here instead.
      if (video.currentTime >= trimEnd) { stopRecording(); return; }
      if (Math.abs(video.currentTime - lastTime) < 1e-3) {
        stalledChecks++;
        if (stalledChecks === 1) {
          video.play().catch(() => {});
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
  }).catch(e => failExport(t('video.errSeek', { msg: (e && e.message ? e.message : e) }), e));
}

// Video codec at this frame size, or null when WebCodecs has no usable config
// (the export then stops with video.errNoEncoder).
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

// Audio codec for the export: AAC in MP4 where the browser has an AAC
// encoder (Chrome, Edge), Opus otherwise (Firefox only encodes Opus, which
// MP4 carries too). WebM is always Opus. null when there is no AudioEncoder.
const EXPORT_AUDIO_RATE = 48000;
async function pickWebCodecsAudio(container, channels) {
  if (typeof window.AudioEncoder !== 'function') return null;
  const cands = container === 'mp4'
    ? [{ codec: 'mp4a.40.2', mux: 'aac', label: 'AAC' }, { codec: 'opus', mux: 'opus', label: 'Opus' }]
    : [{ codec: 'opus', mux: 'A_OPUS', label: 'Opus' }];
  for (const c of cands) {
    try {
      const s = await window.AudioEncoder.isConfigSupported({
        codec: c.codec, sampleRate: EXPORT_AUDIO_RATE, numberOfChannels: channels, bitrate: EXPORT_AUDIO_BITRATE,
      });
      if (s && s.supported) return c;
    } catch {}
  }
  return null;
}

// decodeAudioData needs the whole file in memory, so a very large file is
// exported without sound rather than risk running the tab out of memory.
const AUDIO_DECODE_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;

// The export cannot record the element's sound (it seeks frame by frame), so the sound is decoded from the file itself, cut to the export
// range and encoded with WebCodecs, all before the video frames. Resolves to
// { config, chunks: [{ chunk, meta }] } for the muxer, or throws with a reason
// the user is shown.
async function encodeExportAudio(file, container, trimStart, trimEnd, isCancelled) {
  if (!file) throw new Error('no file');
  if (file.size > AUDIO_DECODE_MAX_BYTES) throw new Error(t('video.audioTooLarge'));
  const decodeCtx = new OfflineAudioContext(1, 1, EXPORT_AUDIO_RATE);
  const buffer = await decodeCtx.decodeAudioData(await file.arrayBuffer());
  if (isCancelled()) return null;
  const channels = Math.min(2, buffer.numberOfChannels);
  const pick = await pickWebCodecsAudio(container, channels);
  if (!pick) throw new Error(t('video.audioNoEncoder'));

  const first = Math.max(0, Math.round(trimStart * EXPORT_AUDIO_RATE));
  const last = Math.min(buffer.length, Math.round(trimEnd * EXPORT_AUDIO_RATE));
  const planes = [];
  for (let c = 0; c < channels; c++) planes.push(buffer.getChannelData(c).subarray(first, last));
  const frames = last - first;

  const chunks = [];
  let error = null;
  const encoder = new window.AudioEncoder({
    output: (chunk, meta) => chunks.push({ chunk, meta }),
    error: e => { error = e; },
  });
  encoder.configure({ codec: pick.codec, sampleRate: EXPORT_AUDIO_RATE, numberOfChannels: channels, bitrate: EXPORT_AUDIO_BITRATE });
  // One-second blocks, planar: each channel's samples back to back.
  for (let off = 0; off < frames && !isCancelled(); off += EXPORT_AUDIO_RATE) {
    const n = Math.min(EXPORT_AUDIO_RATE, frames - off);
    const data = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) data.set(planes[c].subarray(off, off + n), c * n);
    const audioData = new window.AudioData({
      format: 'f32-planar', sampleRate: EXPORT_AUDIO_RATE, numberOfFrames: n, numberOfChannels: channels,
      timestamp: Math.round(off / EXPORT_AUDIO_RATE * 1e6), data,
    });
    encoder.encode(audioData);
    audioData.close();
    if (error) throw error;
  }
  await encoder.flush();
  encoder.close();
  if (error) throw error;
  if (!chunks.length) throw new Error('no audio data');
  return { config: { codec: pick.mux, numberOfChannels: channels, sampleRate: EXPORT_AUDIO_RATE }, chunks };
}

// ── Sequential decode (MP4) ──
// The export's fast path for MP4/MOV: rather than seeking the <video> element
// to every output frame (each seek decodes forward from the previous keyframe,
// which on 1080p60 footage and integrated graphics can take seconds), the
// video samples are read straight from the file and decoded once each, in
// order, with a WebCodecs VideoDecoder. Memory stays flat, since only a few
// frames are ever held. Anything this cannot read (rotated phone video,
// complex edit lists, other codecs) falls back to seeking, and so does a
// decoder that fails part way, from the frame it stopped at.

// The video track's sample table, in decode order: { codec, description, hevc,
// width, height, count, offsets, sizes, ptsUs, durUs, key }, timestamps in
// presentation microseconds on the <video> element's own clock. null for
// anything not handled.
function readMp4VideoSamples(file) {
  return readMoovBytes(file).then(function(moov) {
    if (!moov) return null;
    var dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
    var child = function(box, type) {
      return mp4ChildBoxes(moov, box.start, box.end).find(function(b) { return b.type === type; }) || null;
    };
    var top = mp4ChildBoxes(moov, 0, moov.length);
    var mvhd = top.find(function(b) { return b.type === 'mvhd'; });
    if (!mvhd) return null;
    var movieScale = dv.getUint32(mvhd.start + (moov[mvhd.start] === 1 ? 20 : 12));
    var traks = top.filter(function(b) { return b.type === 'trak'; });
    for (var i = 0; i < traks.length; i++) {
      var mdia = child(traks[i], 'mdia');
      var hdlr = mdia && child(mdia, 'hdlr');
      if (!hdlr || fourccAt(moov, hdlr.start + 8) !== 'vide') continue;
      return readVideoTrak(moov, dv, child, traks[i], mdia, movieScale);
    }
    return null;
  }).catch(function(e) {
    console.warn('[FlySight] could not read the MP4 sample table', e);
    return null;
  });
}

function readVideoTrak(moov, dv, child, trak, mdia, movieScale) {
  // A rotation matrix is applied by <video> but not to a decoded VideoFrame.
  var tkhd = child(trak, 'tkhd');
  if (!tkhd) return null;
  var m = tkhd.start + (moov[tkhd.start] === 1 ? 52 : 40);
  if (dv.getInt32(m) !== 0x10000 || dv.getInt32(m + 4) !== 0 ||
      dv.getInt32(m + 12) !== 0 || dv.getInt32(m + 16) !== 0x10000) return null;

  var mdhd = child(mdia, 'mdhd');
  var minf = child(mdia, 'minf');
  var stbl = minf && child(minf, 'stbl');
  if (!mdhd || !stbl) return null;
  var scale = dv.getUint32(mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));
  if (!scale || !movieScale) return null;

  // Edit list: an optional leading empty edit (a delay) and one plain edit
  // (the media time playback starts at), the shape cameras write. Anything
  // more involved is left to the browser.
  var delayUs = 0, shift = 0;
  var edts = child(trak, 'edts');
  var elst = edts && child(edts, 'elst');
  if (elst) {
    var v1 = moov[elst.start] === 1;
    var n = dv.getUint32(elst.start + 4);
    var p = elst.start + 8, plain = 0;
    for (var e = 0; e < n; e++) {
      var segDur = v1 ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
      var mediaTime = v1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
      var rate = dv.getInt32(p + (v1 ? 16 : 8));
      p += v1 ? 20 : 12;
      if (mediaTime === -1) {
        if (plain) return null;
        delayUs += segDur / movieScale * 1e6;
        continue;
      }
      if (plain++ || rate !== 0x10000) return null;
      shift = mediaTime;
    }
  }

  var stsd = child(stbl, 'stsd');
  if (!stsd || stsd.start + 94 > stsd.end) return null;
  var entry = stsd.start + 8;
  var fourcc = fourccAt(moov, entry + 4);
  var width = dv.getUint16(entry + 32), height = dv.getUint16(entry + 34);
  var entryEnd = Math.min(stsd.end, entry + dv.getUint32(entry));
  var configs = mp4ChildBoxes(moov, entry + 86, entryEnd);
  var codec = null, cfg = null;
  if (fourcc === 'avc1' || fourcc === 'avc3') {
    cfg = configs.find(function(b) { return b.type === 'avcC'; });
    if (!cfg || cfg.start + 4 > cfg.end) return null;
    var hex = function(b) { return moov[b].toString(16).padStart(2, '0'); };
    codec = fourcc + '.' + hex(cfg.start + 1) + hex(cfg.start + 2) + hex(cfg.start + 3);
  } else if (fourcc === 'hvc1' || fourcc === 'hev1') {
    cfg = configs.find(function(b) { return b.type === 'hvcC'; });
    if (!cfg || cfg.start + 13 > cfg.end) return null;
    codec = hevcCodecString(fourcc, moov, cfg.start);
  } else {
    return null;
  }
  var description = moov.slice(cfg.start, cfg.end);

  var stts = child(stbl, 'stts'), stsz = child(stbl, 'stsz'), stsc = child(stbl, 'stsc');
  var stco = child(stbl, 'stco'), co64 = child(stbl, 'co64');
  var ctts = child(stbl, 'ctts'), stss = child(stbl, 'stss');
  if (!stts || !stsz || !stsc || !(stco || co64)) return null;

  var count = dv.getUint32(stsz.start + 8);
  if (!count) return null;
  var fixedSize = dv.getUint32(stsz.start + 4);
  var sizes = new Uint32Array(count);
  for (var s = 0; s < count; s++) sizes[s] = fixedSize || dv.getUint32(stsz.start + 12 + s * 4);

  // Decode times and durations, in track ticks.
  var dts = new Float64Array(count), dur = new Float64Array(count);
  var k = 0, t = 0;
  var sttsN = dv.getUint32(stts.start + 4);
  for (var a = 0, q = stts.start + 8; a < sttsN && k < count; a++, q += 8) {
    var c = dv.getUint32(q), d = dv.getUint32(q + 4);
    for (var j = 0; j < c && k < count; j++, k++) { dts[k] = t; dur[k] = d; t += d; }
  }
  if (k !== count) return null;

  // Composition offsets (B-frames). Read signed: version 0 is unsigned on
  // paper, but writers put negative offsets there too.
  var cto = new Float64Array(count);
  if (ctts) {
    k = 0;
    var cttsN = dv.getUint32(ctts.start + 4);
    for (var b = 0, r = ctts.start + 8; b < cttsN && k < count; b++, r += 8) {
      var cc = dv.getUint32(r), off = dv.getInt32(r + 4);
      for (var jj = 0; jj < cc && k < count; jj++) cto[k++] = off;
    }
  }

  var key = new Uint8Array(count);
  if (stss) {
    var stssN = dv.getUint32(stss.start + 4);
    for (var y = 0; y < stssN; y++) {
      var num = dv.getUint32(stss.start + 8 + y * 4);
      if (num >= 1 && num <= count) key[num - 1] = 1;
    }
  } else {
    key.fill(1);
  }
  if (!key[0]) return null;

  // File offsets: chunks from stco/co64, samples per chunk from stsc.
  var chunkCount = dv.getUint32((stco || co64).start + 4);
  var chunkOffset = function(ci) {
    return stco ? dv.getUint32(stco.start + 8 + ci * 4)
      : dv.getUint32(co64.start + 8 + ci * 8) * 4294967296 + dv.getUint32(co64.start + 12 + ci * 8);
  };
  var offsets = new Float64Array(count);
  var stscN = dv.getUint32(stsc.start + 4);
  k = 0;
  for (var g = 0; g < stscN && k < count; g++) {
    var base = stsc.start + 8 + g * 12;
    var firstChunk = dv.getUint32(base) - 1;
    var perChunk = dv.getUint32(base + 4);
    var lastChunk = g + 1 < stscN ? dv.getUint32(base + 12) - 1 : chunkCount;
    for (var ch = firstChunk; ch < lastChunk && k < count; ch++) {
      var pos = chunkOffset(ch);
      for (var z = 0; z < perChunk && k < count; z++, k++) { offsets[k] = pos; pos += sizes[k]; }
    }
  }
  if (k !== count) return null;

  var ptsUs = new Float64Array(count), durUs = new Float64Array(count);
  for (var w = 0; w < count; w++) {
    ptsUs[w] = Math.round((dts[w] + cto[w] - shift) / scale * 1e6 + delayUs);
    durUs[w] = Math.round(dur[w] / scale * 1e6);
  }
  return { codec: codec, description: description, hevc: fourcc[0] === 'h', width: width, height: height,
    count: count, offsets: offsets, sizes: sizes, ptsUs: ptsUs, durUs: durUs, key: key };
}

// RFC 6381 codec string for HEVC from the hvcC record, e.g. hvc1.1.6.L120.B0.
function hevcCodecString(fourcc, bytes, p) {
  var space = bytes[p + 1] >> 6;
  var tier = (bytes[p + 1] >> 5) & 1;
  var profile = bytes[p + 1] & 0x1f;
  var compat = ((bytes[p + 2] << 24) | (bytes[p + 3] << 16) | (bytes[p + 4] << 8) | bytes[p + 5]) >>> 0;
  var reversed = 0;
  for (var i = 0; i < 32; i++) { reversed = (reversed << 1) | (compat & 1); compat >>>= 1; }
  var s = fourcc + '.' + ['', 'A', 'B', 'C'][space] + profile + '.' + (reversed >>> 0).toString(16).toUpperCase() +
    '.' + (tier ? 'H' : 'L') + bytes[p + 12];
  var cons = [];
  for (var j = 0; j < 6; j++) cons.push(bytes[p + 6 + j]);
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  cons.forEach(function(c) { s += '.' + c.toString(16).toUpperCase(); });
  return s;
}

// Whether a sample holds a picture the decoder can start from: an IRAP NAL
// unit (types 16-23) in HEVC, an IDR slice (type 5) in H.264. The NAL length
// field size comes from the hvcC / avcC record.
function holdsKeyframe(bytes, description, hevc) {
  const lenSize = ((hevc ? description[21] : description[4]) & 3) + 1;
  let p = 0;
  while (p + lenSize < bytes.length) {
    let len = 0;
    for (let i = 0; i < lenSize; i++) len = len * 256 + bytes[p + i];
    const type = hevc ? (bytes[p + lenSize] >> 1) & 0x3f : bytes[p + lenSize] & 0x1f;
    if (hevc ? type >= 16 && type <= 23 : type === 5) return true;
    p += lenSize + len;
  }
  return false;
}

// Chunks waiting in the decoder, and how long it may go without producing a
// frame before it counts as stuck.
const DECODE_QUEUE_MAX = 4;
const DECODE_STALL_MS = 20000;
const DECODE_READ_WINDOW = 8 * 1024 * 1024;

// Opens the sequential source for an export starting at trimStart. Resolves
// to { drawFrame(ctx, w, h, timeSec, isCancelled) → Promise<bool>, close() },
// or null when this file or browser cannot use it (the caller then seeks).
// `video` is the preview element, seeked once to line the decoder's clock up
// with the one the exit was marked on (see calibrateDecodeShift).
async function openMp4FrameSource(file, trimStart, video) {
  if (!file || typeof window.VideoDecoder !== 'function' || typeof window.EncodedVideoChunk !== 'function') return null;
  const track = await readMp4VideoSamples(file);
  if (!track) return null;
  const config = { codec: track.codec, description: track.description, codedWidth: track.width, codedHeight: track.height };
  try {
    const s = await window.VideoDecoder.isConfigSupported(config);
    if (!s || !s.supported) return null;
  } catch { return null; }
  const shiftUs = video ? await calibrateDecodeShift(file, track, config, trimStart, video) : 0;
  if (shiftUs === null) return null;
  return startSequentialDecode(file, track, config, trimStart, shiftUs);
}

// Browsers do not agree with the file, or with each other, on where frames
// sit in time once edit lists and B-frame delays are involved: Chrome shows
// this repo's sample a whole frame earlier than its own timestamps say. The
// exit was marked on the element's clock, so that is the one that counts.
// One frame is matched against the element instead of guessing the rule:
// the decoded frames around a moment are compared with the element's picture
// at that moment, and the best match gives the shift, in µs, from file time to
// element time. A black or still stretch matches several frames equally, so a
// few moments from the start on are tried until one gives a clear answer;
// with none, no shift. null when the decoder cannot run on this file at all.
const CALIBRATE_FRAMES = 3;
const CALIBRATE_AT_SEC = [0, 1, 2.5, 5, 10, 20];
// In mean grey levels (0-255): the best match must be at most CALIBRATE_MATCH
// off (two decoders' colour conversion differs by about 0.25), and beat the
// next one by CALIBRATE_CLEAR.
const CALIBRATE_MATCH = 2;
const CALIBRATE_CLEAR = 1;
async function calibrateDecodeShift(file, track, config, startSec, video) {
  const lastSec = (track.ptsUs.reduce((m, v) => Math.max(m, v), 0)) / 1e6;
  for (const offset of CALIBRATE_AT_SEC) {
    const at = startSec + offset;
    if (at > lastSec) break;
    const r = await calibrateDecodeShiftAt(file, track, config, at, video);
    if (r === null) return null;
    if (r.clear) return r.shiftUs;
  }
  return 0;
}

// One attempt at timeSec: { shiftUs, clear }, or null if the decoder failed.
async function calibrateDecodeShiftAt(file, track, config, timeSec, video) {
  const W = 96, H = 54;
  const canvas = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c.getContext('2d', { willReadFrequently: true });
  };
  const ref = canvas(), probeCtx = canvas();
  try {
    await seekVideoTo(video, timeSec, {});
  } catch { return { shiftUs: 0, clear: false }; }
  ref.drawImage(video, 0, 0, W, H);
  const refPx = ref.getImageData(0, 0, W, H).data;

  // Presentation times of the frames either side of the one the file puts
  // on screen at timeSec.
  const sorted = Array.from(track.ptsUs).sort((a, b) => a - b);
  const targetUs = Math.round(timeSec * 1e6) + 1;
  let pos = 0;
  while (pos + 1 < sorted.length && sorted[pos + 1] <= targetUs) pos++;
  // Too close to either end (or before the first frame) to compare both ways.
  if (sorted[0] > targetUs || pos < CALIBRATE_FRAMES || pos + CALIBRATE_FRAMES >= sorted.length) {
    return { shiftUs: 0, clear: false };
  }
  const from = pos - CALIBRATE_FRAMES, to = pos + CALIBRATE_FRAMES;

  const probe = await startSequentialDecode(file, track, config, sorted[from] / 1e6, 0);
  if (!probe) return null;
  const scores = [];
  try {
    for (let p = from; p <= to; p++) {
      if (!(await probe.drawFrame(probeCtx, W, H, sorted[p] / 1e6, () => false))) continue;
      const px = probeCtx.getImageData(0, 0, W, H).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) {
        sum += Math.abs(px[i] - refPx[i]) + Math.abs(px[i + 1] - refPx[i + 1]) + Math.abs(px[i + 2] - refPx[i + 2]);
      }
      scores.push({ p, diff: sum / (W * H * 3) });
    }
  } catch (e) {
    console.warn('[FlySight] decoder calibration failed', e);
    return null;
  } finally {
    probe.close();
  }
  if (scores.length < 2) return { shiftUs: 0, clear: false };
  scores.sort((a, b) => a.diff - b.diff);
  return {
    shiftUs: sorted[pos] - sorted[scores[0].p],
    clear: scores[0].diff <= CALIBRATE_MATCH && scores[1].diff - scores[0].diff >= CALIBRATE_CLEAR,
  };
}

// The decoder proper, with file times moved by shiftUs onto the element's
// clock. null when no usable keyframe precedes the start.
async function startSequentialDecode(file, track, config, trimStart, shiftUs) {
  const { count, offsets, sizes, ptsUs, durUs, key } = track;
  // Start at the keyframe that the frame on screen at trimStart depends on:
  // the last one at or before it in both decode and presentation order.
  const startUs = Math.round(trimStart * 1e6) - shiftUs + 1;
  let shown = -1;
  for (let k = 0; k < count; k++) {
    if (ptsUs[k] <= startUs && (shown < 0 || ptsUs[k] > ptsUs[shown])) shown = k;
  }
  // Some cameras mark samples as sync that hold no real keyframe (intra
  // refresh: no IDR at all). <video> copes, the decoder refuses them, so such
  // a sample is skipped for an earlier one, and a file with none is seeked.
  let next = -1;
  for (let k = shown >= 0 ? shown : 0; k >= 0; k--) {
    if (!key[k] || (shown >= 0 && ptsUs[k] > ptsUs[shown])) continue;
    const bytes = await readFileBytes(file, offsets[k], sizes[k]);
    if (holdsKeyframe(bytes, track.description, track.hevc)) { next = k; break; }
  }
  if (next < 0) return null;

  const pending = [];   // decoded frames past the current one, in presentation order
  let current = null;   // the frame on screen at the last target time
  let error = null;
  let flushing = null, flushed = false;
  let wake = null;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };
  const decoder = new window.VideoDecoder({
    output: frame => {
      let at = pending.length;
      while (at > 0 && pending[at - 1].timestamp > frame.timestamp) at--;
      pending.splice(at, 0, frame);
      notify();
    },
    error: e => { error = error || e; notify(); },
  });
  decoder.configure(config);

  // Samples are read through a window of the file, since consecutive samples
  // sit close together and one read per sample would be slow.
  let win = null, winStart = 0;
  async function sampleBytes(k) {
    const off = offsets[k], size = sizes[k];
    if (!win || off < winStart || off + size > winStart + win.length) {
      win = await readFileBytes(file, off, Math.max(DECODE_READ_WINDOW, size));
      winStart = off;
      if (win.length < size) throw new Error('the video file ends early');
    }
    return win.subarray(off - winStart, off - winStart + size);
  }
  async function feed() {
    const k = next++;
    const data = await sampleBytes(k);
    decoder.decode(new window.EncodedVideoChunk({
      type: key[k] ? 'key' : 'delta', timestamp: ptsUs[k], duration: durUs[k], data,
    }));
  }
  function waitForOutput() {
    return new Promise(resolve => {
      const timer = setTimeout(() => { wake = null; resolve(false); }, DECODE_STALL_MS);
      wake = () => { clearTimeout(timer); resolve(true); };
    });
  }

  async function drawFrame(ctx, w, h, timeSec, isCancelled) {
    const limitUs = Math.round(timeSec * 1e6) - shiftUs + 1;
    for (;;) {
      if (error) throw error;
      if (isCancelled()) return false;
      while (pending.length && pending[0].timestamp <= limitUs) {
        if (current) current.close();
        current = pending.shift();
      }
      // A decoded frame past the target means the current one is on screen
      // at that time; frames come out in presentation order.
      if (pending.length || flushed) break;
      if (next < count && decoder.decodeQueueSize < DECODE_QUEUE_MAX) { await feed(); continue; }
      if (next >= count && !flushing) {
        flushing = decoder.flush().then(() => { flushed = true; notify(); }, e => { error = error || e; notify(); });
      }
      if (!(await waitForOutput()) && !flushed) throw new Error('the video decoder stopped producing frames');
    }
    // Before the first frame, the first frame is what the element shows.
    const frame = current || pending[0];
    if (!frame) return false;
    ctx.drawImage(frame, 0, 0, w, h);
    return true;
  }

  function close() {
    if (current) { current.close(); current = null; }
    while (pending.length) pending.shift().close();
    try { if (decoder.state !== 'closed') decoder.close(); } catch {}
  }

  return { drawFrame, close, codec: track.codec, shiftUs };
}

// Reloads the <video> element, which resets the browser's decoder after it got
// stuck on a seek (seen on slow machines with integrated graphics, often after
// many minutes). Resolves once the element can show a frame again.
const VIDEO_RELOAD_TIMEOUT_MS = 30000;
function reloadVideoElement(video) {
  return new Promise((resolve, reject) => {
    const done = ok => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onData);
      video.removeEventListener('error', onError);
      if (ok) resolve(); else reject(new Error('the video could not be reloaded'));
    };
    const onData = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), VIDEO_RELOAD_TIMEOUT_MS);
    video.addEventListener('loadeddata', onData);
    video.addEventListener('error', onError);
    video.load();
    video.muted = true;
  });
}

// The export: WebCodecs VideoEncoder, frame by frame. Decoupled from
// real-time playback, so a slow CPU only makes it take longer; it never
// stalls and the output timing is frame-accurate (explicit timestamps).
// The default. It used to be the opt-in "Reliable mode"; the real-time path
// is now the opt-in one, as Direct render (beta), above.
async function exportWithWebCodecs(opts) {
  const { video, canvas, ctx, contentRect, trimStart, trimEnd, fps, bitrate, setProgress, finishExport, failExport, abortExport } = opts;

  const FPS = fps;
  const width = canvas.width;
  const height = canvas.height;
  let cancelled = false;
  state.activeExportCancel = () => {
    if (cancelled) return;
    cancelled = true;
    document.getElementById('progressText').textContent = t('video.cancelling');
    document.getElementById('exportCancelBtn').disabled = true;
  };

  let source = null;  // the sequential MP4 decoder, while it is in use
  try {
    let muxer, target, codec, fileExt, mimeType;

    const pick = await pickWebCodecsCodec(width, height);
    if (!pick) {
      failExport(t('video.errNoEncoder', { res: width + ' × ' + height }));
      return;
    }

    // Sound first: it decides the muxer's audio track. A failure here costs
    // only the sound, never the export; the user is told afterwards.
    let audio = null;
    let audioSkipped = null;
    if (opts.wantAudio) {
      setProgress(0, t('video.preparingAudio'));
      try {
        audio = await encodeExportAudio(opts.file, pick.container, trimStart, trimEnd, () => cancelled);
      } catch (e) {
        console.warn('[FlySight] exporting without sound', e);
        audioSkipped = (e && e.message) || String(e);
      }
    }
    if (cancelled) { abortExport(); return; }

    if (pick.container === 'mp4') {
      codec = pick.codec;
      fileExt = '.mp4';
      mimeType = 'video/mp4';
      target = new window.Mp4Muxer.ArrayBufferTarget();
      muxer = new window.Mp4Muxer.Muxer({
        target,
        video: { codec: 'avc', width, height },
        audio: audio ? audio.config : undefined,
        fastStart: 'in-memory',
        // Firefox stamps canvas-built VideoFrames document-relative (ignoring our
        // explicit timestamp), so the first chunk isn't at 0. 'offset' normalizes
        // all timestamps to a zero base. No-op on Chrome (first chunk already 0).
        firstTimestampBehavior: 'offset',
      });
    } else {
      codec = pick.codec;
      fileExt = '.webm';
      mimeType = 'video/webm';
      target = new window.WebMMuxer.ArrayBufferTarget();
      muxer = new window.WebMMuxer.Muxer({
        target,
        video: { codec: 'V_VP9', width, height, frameRate: FPS },
        audio: audio ? audio.config : undefined,
        // See note above: normalize Firefox's non-zero first timestamp to 0.
        firstTimestampBehavior: 'offset',
      });
    }

    // Audio chunks are handed to the muxer interleaved with the video, each
    // once the frames have caught up with it, which both muxers expect.
    let audioIdx = 0;
    const addAudioUpTo = us => {
      if (!audio) return;
      while (audioIdx < audio.chunks.length && audio.chunks[audioIdx].chunk.timestamp <= us) {
        const { chunk, meta } = audio.chunks[audioIdx++];
        muxer.addAudioChunk(chunk, meta);
      }
    };

    let encoderError = null;
    const encoder = new window.VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { encoderError = e; },
    });
    // 'realtime' hints the encoder to avoid frame reordering. Firefox ignores it
    // for H.264 (hence the Baseline-profile codec choice above, which forbids
    // B-frames outright), but it's harmless and helps encoders that do honor it.
    encoder.configure({ codec, width, height, bitrate, framerate: FPS, latencyMode: 'realtime' });

    const totalFrames = Math.max(1, Math.ceil((trimEnd - trimStart) * FPS));
    // Time left, from the average time per frame so far, smoothed so it does
    // not jitter. Held back for the first seconds, when one slow seek would
    // throw the figure off wildly.
    const loopStart = performance.now();
    let etaSmoothed = null;
    let etaText = null, etaShownAt = 0;
    const keyEvery = Math.max(1, Math.round(FPS));
    video.muted = true;
    try { if (!video.paused) video.pause(); } catch {}

    // MP4 is decoded straight from the file where possible; everything else,
    // and whatever is left after a decoder failure, seeks the <video> element.
    source = await openMp4FrameSource(opts.file, trimStart, video).catch(e => {
      console.warn('[FlySight] sequential decode unavailable, seeking instead', e);
      return null;
    });
    if (cancelled) { abortExport(); return; }

    // Seeks to the frame and draws it. A seek that times out reloads the video
    // element (resetting the browser's decoder) and tries the same frame
    // again, so a stuck decoder no longer throws away the export so far.
    const seekAndDraw = async (seekTime, i) => {
      for (let reloads = 0; ; reloads++) {
        try {
          await seekVideoTo(video, seekTime, {
            onSlow: () => setProgress((i / totalFrames) * 100, t('video.seekSlow')),
            isCancelled: () => cancelled,
          });
          break;
        } catch (e) {
          if (cancelled || reloads >= SEEK_RELOADS_MAX) throw e;
          console.warn('[FlySight] seek timed out at frame ' + (i + 1) + ', reloading the video', e);
          setProgress((i / totalFrames) * 100, t('video.decoderRestart', { i: i + 1 }));
          await reloadVideoElement(video);
        }
      }
      if (!cancelled) ctx.drawImage(video, 0, 0, width, height);
    };

    for (let i = 0; i < totalFrames; i++) {
      if (cancelled) break;
      if (encoderError) throw encoderError;
      // Never seek to exactly video.duration — some browsers won't fire 'seeked'
      // there, which would otherwise time out (e.g. a crop that runs to the end
      // of the video, so trimEnd is video.duration).
      // Not named `t` — that's the global translation function, used below.
      const seekTime = Math.min(trimStart + i / FPS, trimEnd, Math.max(0, video.duration - 0.01));
      let frameTime = seekTime;
      let drawn = false;
      if (source) {
        try {
          drawn = await source.drawFrame(ctx, width, height, seekTime, () => cancelled);
        } catch (e) {
          console.warn('[FlySight] sequential decode failed at frame ' + (i + 1) + ', seeking from here', e);
          source.close();
          source = null;
        }
      }
      if (cancelled) break;
      if (!drawn) {
        await seekAndDraw(seekTime, i);
        if (cancelled) break;
        frameTime = video.currentTime;
      }

      const dataIdx = videoTimeToDataIndex(frameTime);
      drawExportWidgets(ctx, contentRect, dataIdx);

      const timestamp = Math.round((i / FPS) * 1e6);
      addAudioUpTo(timestamp);
      const frame = new window.VideoFrame(canvas, {
        timestamp,
        duration: Math.round(1e6 / FPS),
      });
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();

      const pct = ((i + 1) / totalFrames) * 100;
      const now = performance.now();
      const elapsed = (now - loopStart) / 1000;
      if (elapsed >= 3 && i >= 4) {
        const raw = elapsed / (i + 1) * (totalFrames - i - 1);
        etaSmoothed = etaSmoothed == null ? raw : etaSmoothed * 0.9 + raw * 0.1;
      }
      // The figure shown changes every few seconds, not every frame, and
      // starts on the high side: an export tends to slow down as it goes
      // (graphics memory filling up), so the early pace flatters it.
      if (etaSmoothed != null && (etaText == null || now - etaShownAt >= EXPORT_ETA_REFRESH_MS)) {
        etaText = formatExportEta(etaSmoothed * (1 + EXPORT_ETA_START_MARGIN * (1 - pct / 100)));
        etaShownAt = now;
      }
      setProgress(pct, etaText == null
        ? t('video.exportingFrame', { i: i + 1, total: totalFrames })
        : t('video.exportingFrameEta', { i: i + 1, total: totalFrames, left: etaText }));

      // Backpressure: let the encoder drain so memory stays bounded.
      while (encoder.encodeQueueSize > EXPORT_ENCODE_QUEUE_MAX && !cancelled) {
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
    addAudioUpTo(Infinity);
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: mimeType });
    finishExport(blob, fileExt);
    if (audioSkipped) alert(t('video.audioSkipped', { msg: audioSkipped }));
  } catch (e) {
    failExport(t('video.errExport', { msg: (e && e.message ? e.message : e) }), e);
  } finally {
    if (source) source.close();
  }
}

// Wire up preview updates
window.addEventListener('resize', drawOverlayPreview);

// Draw preview when video loads
document.getElementById('videoPreview').addEventListener('loadeddata', function() {
  drawOverlayPreview();
});
