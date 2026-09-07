// ── In-browser H.265/HEVC to H.264 conversion (ffmpeg.wasm) ──
//
// The overlay pipeline's only decoder is the <video> element, so footage the
// browser cannot decode has to become H.264 before anything downstream can
// touch it. In practice that means H.265/HEVC, which only Chrome and Edge play
// (see "Video codec support" in CLAUDE.md). ffmpeg.wasm re-encodes it locally,
// so the footage never leaves the machine.
//
// The scripts are vendored like every other library, but the 30.7 MB core
// binary is the one exception to the "no CDN" rule in CLAUDE.md: committing it
// would triple the size of the repo for a feature most users never touch. It
// comes from jsDelivr instead, pinned by version AND by Subresource-Integrity
// hash, so a compromised CDN cannot swap it for something else.
//
// Nothing here is loaded by index.html: the script tag is injected on first
// use, so a user who never converts anything pays nothing.
//
// Requires http(s). On a file:// origin both the Worker and the wasm fetch are
// blocked by the browser, so canOfferVideoConvert() returns false there and
// video.js falls back to its plain "re-encode it yourself" alert.

var FFMPEG_DIR = 'vendor/ffmpeg/';
var FFMPEG_CORE_MB = 31;

// @ffmpeg/core 0.12.10. Bump both together, and recompute the hash with:
//   node -e "const c=require('crypto'),f=require('fs');console.log('sha384-'+c.createHash('sha384').update(f.readFileSync(process.argv[1])).digest('base64'))" ffmpeg-core.wasm
var FFMPEG_WASM_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm';
var FFMPEG_WASM_INTEGRITY = 'sha384-U1VDhkPYrM3wTCT4/vjSpSsKqG/UjljYrYCI4hBSJ02svbCkxuCi6U6u/peg5vpW';

// Codecs the browser cannot play but ffmpeg.wasm can decode, so a conversion is
// worth offering. Same fourccs video.js sniffs out of the file.
var CONVERTIBLE_FOURCC = [
  'hev1', 'hvc1', 'dvh1', 'dvhe',
  'apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x',
  'mp4v', 'mjpa', 'mjpb', 'dvc', 'dvcp', 'rle ',
];

// libx264 at `ultrafast`: the only preset that finishes in minutes rather than
// the better part of an hour in a single-threaded wasm build, and the quality
// is fine for footage that is about to be re-encoded again on export anyway.
// Audio is dropped because the exported overlay video has none.
var FFMPEG_CONVERT_ARGS = [
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
  '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart',
];

// Observed throughput, in wall-clock seconds per second of video, persisted in
// the `settings` object store. ffmpeg.wasm is single-threaded, so this tracks
// single-core clock speed and varies several-fold between machines: measured
// ~6x on the dev desktop, and a throttling laptop can be 2-3x worse. Hence a
// stored per-machine figure rather than a constant.
var CONVERT_RATE_KEY = 'hevcConvertRate';

// Throughput range used only for the first-run estimate, before this machine
// has measured itself. The low end is the dev desktop (~4.2x measured); the
// high end allows for a laptop running 2-3x slower on battery. Stated as a
// range because a single number would be wrong on unknown hardware, and a
// wrong number is worse than an honest span.
var CONVERT_RATE_LOW = 4;
var CONVERT_RATE_HIGH = 15;

var ffmpegInstance = null;
var ffmpegLoading = null;
var convertPendingFile = null;
var convertPendingCodec = null;    // { fourcc, codecName }, kept for re-rendering
var convertPendingDuration = null; // seconds from mvhd, null when unreadable
var convertPendingRate = null;     // seconds of work per second of video
var convertEtaSmoothed = null;
var convertRunning = false;
var convertCancelled = false;
// Rolling tail of ffmpeg's stderr, so a non-zero exit can name its own reason
// ("Invalid data found when processing input") instead of surfacing the
// downstream "FS error" from reading an output file that was never written.
var ffmpegLogTail = [];

function canOfferVideoConvert(fourcc) {
  return CONVERTIBLE_FOURCC.indexOf(fourcc) >= 0 &&
    location.protocol !== 'file:' &&
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined';
}

// The command the user would run themselves, shown in the panel's details
// block. Uses a slower preset than we do, since native ffmpeg can afford it.
function ffmpegManualCommand(name) {
  return 'ffmpeg -i "' + name + '" -c:v libx264 -crf 20 -c:a aac -movflags +faststart out.mp4';
}

function convertedFileName(name) {
  return name.replace(/\.[^.\/\\]+$/, '') + ' (H.264).mp4';
}

function loadScriptOnce(src) {
  return new Promise(function(resolve, reject) {
    var prev = document.querySelector('script[data-lazy-src="' + src + '"]');
    if (prev) {
      if (prev.dataset.loaded === '1') return resolve();
      prev.addEventListener('load', function() { resolve(); });
      prev.addEventListener('error', function() { reject(new Error('could not load ' + src)); });
      return;
    }
    var s = document.createElement('script');
    s.dataset.lazySrc = src;
    s.onload = function() { s.dataset.loaded = '1'; resolve(); };
    s.onerror = function() { reject(new Error('could not load ' + src)); };
    // src last: webpack derives the worker's base URL from document.currentScript,
    // so ffmpeg.js must be fetched from vendor/ffmpeg/ for it to find
    // 814.ffmpeg.js next to it.
    s.src = src;
    document.head.appendChild(s);
  });
}

// ffmpeg.wasm's worker cannot instantiate a cross-origin wasmURL directly, so
// the CDN binary is turned into a same-origin blob URL first. fetch() enforces
// the integrity hash for us and rejects on a mismatch. `force-cache` skips a
// revalidation round trip on later sessions, which the CDN's immutable
// cache-control already makes safe.
var ffmpegWasmBlobURL = null;
function ffmpegWasmURL() {
  if (ffmpegWasmBlobURL) return Promise.resolve(ffmpegWasmBlobURL);
  return fetch(FFMPEG_WASM_URL, { integrity: FFMPEG_WASM_INTEGRITY, cache: 'force-cache' })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    })
    .then(function(blob) {
      ffmpegWasmBlobURL = URL.createObjectURL(blob);
      return ffmpegWasmBlobURL;
    })
    .catch(function(e) {
      throw new Error(t('convert.errDownload', { msg: (e && e.message) || String(e) }));
    });
}

function ensureFfmpeg() {
  if (ffmpegInstance) return Promise.resolve(ffmpegInstance);
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = loadScriptOnce(FFMPEG_DIR + 'ffmpeg.js').then(function() {
    if (typeof FFmpegWASM === 'undefined' || !FFmpegWASM.FFmpeg) {
      throw new Error('ffmpeg.wasm did not register its global');
    }
    var ff = new FFmpegWASM.FFmpeg();
    ff.on('log', function(e) {
      // ffmpeg's own stderr. Kept on console only; the panel shows progress.
      if (!e || !e.message) return;
      console.debug('[ffmpeg]', e.message);
      ffmpegLogTail.push(e.message);
      if (ffmpegLogTail.length > 12) ffmpegLogTail.shift();
    });
    return ffmpegWasmURL().then(function(wasmURL) {
      return ff.load({
        coreURL: new URL(FFMPEG_DIR + 'ffmpeg-core.js', location.href).href,
        wasmURL: wasmURL,
      });
    }).then(function() { ffmpegInstance = ff; return ff; });
  }).catch(function(e) {
    ffmpegLoading = null;
    throw e;
  });
  return ffmpegLoading;
}

// Drops the instance so the next attempt rebuilds it. Called after a cancel
// (terminate() leaves the worker unusable) and after a failure.
function resetFfmpeg() {
  if (ffmpegInstance) {
    try { ffmpegInstance.terminate(); } catch (e) {}
  }
  ffmpegInstance = null;
  ffmpegLoading = null;
}

// Lines that are never the reason a conversion failed: the version banner,
// progress and stream-summary output, and emscripten's own "Aborted()", which
// is how ffmpeg's exit(1) surfaces and says nothing about the cause.
var FFMPEG_LOG_NOISE = /^(frame=|size=|video:|audio:|built with|configuration:|lib\w+\s|Aborted\(|Press \[q\]|Stream mapping:|Stream #|Metadata:|Input #|Output #|encoder\s*:|x264 \[info\])/;

// Picks the most explanatory line out of ffmpeg's stderr tail.
function ffmpegFailureReason(fallback) {
  for (var i = ffmpegLogTail.length - 1; i >= 0; i--) {
    var line = (ffmpegLogTail[i] || '').trim();
    if (!line || FFMPEG_LOG_NOISE.test(line)) continue;
    // The wasm build always works on in.<ext>; the user knows their own name.
    return line.replace(/^in\.[A-Za-z0-9]+:\s*/, '');
  }
  return fallback || 'ffmpeg could not process this file';
}

// ffmpeg.wasm's own error strings are opaque: an ffmpeg exit(1) arrives as
// emscripten's "Aborted()", and a missing output file as an ErrnoError. Both
// mean "look at the log", so do that.
function convertErrorMessage(e) {
  var msg = (e && e.message) || String(e);
  if (/^Aborted\(/.test(msg) || /ErrnoError|FS error/.test(msg)) {
    return ffmpegFailureReason(msg);
  }
  return msg;
}

async function convertVideoToH264(file, hooks) {
  var stage = function(name) { if (hooks && hooks.onStage) hooks.onStage(name); };
  stage('loading');
  var ff = await ensureFfmpeg();

  var ext = /\.([A-Za-z0-9]+)$/.exec(file.name);
  var inName = 'in.' + (ext ? ext[1].toLowerCase() : 'mp4');
  var outName = 'out.mp4';
  var onProgress = function(e) {
    if (hooks && hooks.onProgress) hooks.onProgress(e && e.progress);
  };
  ff.on('progress', onProgress);
  try {
    stage('reading');
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    stage('encoding');
    ffmpegLogTail = [];
    // exec() resolves with ffmpeg's exit code instead of rejecting, so a
    // failure has to be turned into an error by hand. Without this the first
    // symptom is an opaque "FS error" from reading an output that was never
    // written.
    var code = await ff.exec(['-i', inName].concat(FFMPEG_CONVERT_ARGS, [outName]));
    if (code !== 0) throw new Error(ffmpegFailureReason('ffmpeg exited with code ' + code));
    var data = await ff.readFile(outName);
    if (!data || !data.length) throw new Error('the conversion produced no data');
    return new File([data], convertedFileName(file.name), { type: 'video/mp4' });
  } finally {
    try { ff.off('progress', onProgress); } catch (e) {}
    // Free the wasm heap copies. Both throw if the worker is already gone.
    try { await ff.deleteFile(inName); } catch (e) {}
    try { await ff.deleteFile(outName); } catch (e) {}
  }
}

// ── Panel UI (inside video modal step 1) ──

function showVideoConvertOffer(file, fourcc, codecName) {
  var panel = document.getElementById('videoConvertPanel');
  if (!panel) return;
  convertPendingFile = file;
  convertPendingCodec = { fourcc: fourcc, codecName: codecName };
  convertPendingDuration = null;
  convertPendingRate = null;
  renderConvertOfferText();
  document.getElementById('videoConvertCmd').textContent = ffmpegManualCommand(file.name);
  document.getElementById('videoConvertActions').style.display = '';
  document.getElementById('videoConvertProgress').style.display = 'none';
  document.getElementById('videoConvertBtn').disabled = false;
  panel.style.display = '';

  // Deliberately not awaited: the codec message is the urgent part, and neither
  // read must delay the panel. The estimate line fills in when they land.
  Promise.all([
    typeof readMp4DurationSec === 'function' ? readMp4DurationSec(file) : null,
    typeof getSetting === 'function' ? getSetting(CONVERT_RATE_KEY) : null,
  ]).then(function(r) {
    // Dismissed, or a different file arrived while we were reading.
    if (convertPendingFile !== file) return;
    convertPendingDuration = r[0];
    convertPendingRate = r[1];
    renderConvertOfferText();
  }).catch(function() {});
}

// Both the codec line and the estimate are set from JS, so they are rendered
// through one function that refreshVideoConvertLang() can call again.
function renderConvertOfferText() {
  var msg = document.getElementById('videoConvertMsg');
  var eta = document.getElementById('videoConvertEta');
  if (!msg || !convertPendingCodec) return;
  msg.textContent = t('convert.offer', {
    codec: convertPendingCodec.codecName || convertPendingCodec.fourcc,
    fourcc: convertPendingCodec.fourcc,
    mb: FFMPEG_CORE_MB,
  });
  if (!eta) return;
  if (!convertPendingDuration) {
    // No duration means no honest estimate, so say nothing rather than guess.
    eta.textContent = '';
    eta.style.display = 'none';
    return;
  }
  var secs = Math.round(convertPendingDuration);
  eta.textContent = convertPendingRate
    ? t('convert.etaKnown', {
        time: formatConvertDuration(convertPendingDuration * convertPendingRate),
        secs: secs,
      })
    : t('convert.etaUnknown', {
        low: formatConvertDuration(convertPendingDuration * CONVERT_RATE_LOW),
        high: formatConvertDuration(convertPendingDuration * CONVERT_RATE_HIGH),
        secs: secs,
      });
  eta.style.display = '';
}

// Called from applyLanguage() so a live language switch re-renders this panel.
function refreshVideoConvertLang() {
  var panel = document.getElementById('videoConvertPanel');
  if (panel && panel.style.display !== 'none') renderConvertOfferText();
}

function hideVideoConvertOffer() {
  convertPendingFile = null;
  convertPendingCodec = null;
  var panel = document.getElementById('videoConvertPanel');
  if (panel) panel.style.display = 'none';
}

function setConvertStatus(text, pct) {
  var el = document.getElementById('videoConvertStatus');
  if (el) el.textContent = text;
  if (pct != null) {
    var fill = document.getElementById('videoConvertFill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }
}

function convertElapsed(startedAt) {
  return formatConvertDuration((Date.now() - startedAt) / 1000);
}

function formatConvertDuration(secs) {
  var s = Math.max(0, Math.round(secs));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function showConvertOfferActions() {
  var actions = document.getElementById('videoConvertActions');
  var prog = document.getElementById('videoConvertProgress');
  if (prog) prog.style.display = 'none';
  if (actions) actions.style.display = '';
}

async function startVideoConvert() {
  if (convertRunning || !convertPendingFile) return;
  var file = convertPendingFile;
  convertRunning = true;
  convertCancelled = false;

  document.getElementById('videoConvertActions').style.display = 'none';
  document.getElementById('videoConvertProgress').style.display = '';
  document.getElementById('videoConvertCancelBtn').disabled = false;
  setConvertStatus(t('convert.loading', { mb: FFMPEG_CORE_MB }), 0);

  var startedAt = Date.now();
  var encodeStartedAt = null;
  // Captured now: hideVideoConvertOffer() clears the pending state on success.
  var durationSec = convertPendingDuration;
  convertEtaSmoothed = null;

  try {
    var out = await convertVideoToH264(file, {
      onStage: function(name) {
        if (name === 'loading') setConvertStatus(t('convert.loading', { mb: FFMPEG_CORE_MB }), 0);
        else if (name === 'reading') setConvertStatus(t('convert.reading'), 0);
        else {
          encodeStartedAt = Date.now();
          setConvertStatus(t('convert.encoding', { pct: 0, elapsed: convertElapsed(startedAt) }), 0);
        }
      },
      onProgress: function(p) {
        var pct = Math.round((p || 0) * 100);
        var elapsed = (Date.now() - (encodeStartedAt || startedAt)) / 1000;
        var left = null;
        // Extrapolating from the first samples gives a wildly wrong number, so
        // hold off until there is enough of both signals to be meaningful.
        if (p > 0.03 && elapsed >= 3) {
          var raw = elapsed * (1 - p) / p;
          // Exponential moving average, so the countdown does not jitter.
          convertEtaSmoothed = convertEtaSmoothed == null
            ? raw
            : convertEtaSmoothed * 0.8 + raw * 0.2;
          left = convertEtaSmoothed;
        }
        setConvertStatus(left == null
          ? t('convert.encoding', { pct: pct, elapsed: convertElapsed(startedAt) })
          : t('convert.encodingEta', {
              pct: pct,
              elapsed: convertElapsed(startedAt),
              left: formatConvertDuration(left),
            }), pct);
      },
    });
    if (convertCancelled) return;

    // Record throughput for the next offer's up-front estimate. Measured over
    // the encode phase only: the core download and the file read are roughly
    // constant rather than proportional to clip length, so leaving them out
    // makes the per-second-of-video figure more accurate. Overwritten rather
    // than averaged, so it tracks the machine's current state.
    if (encodeStartedAt && durationSec > 0 && typeof setSetting === 'function') {
      var rate = ((Date.now() - encodeStartedAt) / 1000) / durationSec;
      if (rate > 0 && rate < 600) setSetting(CONVERT_RATE_KEY, rate);
    }

    console.info('[FlySight] converted to H.264', {
      from: file.name, fromSize: file.size, toSize: out.size,
      clipSeconds: durationSec && Math.round(durationSec),
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
    hideVideoConvertOffer();
    handleVideoFile(out);
  } catch (e) {
    resetFfmpeg();
    if (convertCancelled) { showConvertOfferActions(); return; }
    console.warn('[FlySight] conversion failed', e);
    showConvertOfferActions();
    alert(t('convert.failed', { msg: convertErrorMessage(e) }));
  } finally {
    convertRunning = false;
  }
}

function cancelVideoConvert() {
  if (!convertRunning) return;
  convertCancelled = true;
  var btn = document.getElementById('videoConvertCancelBtn');
  if (btn) btn.disabled = true;
  setConvertStatus(t('convert.cancelling'), null);
  // Kills the worker mid-encode; the pending exec() rejects and startVideoConvert's
  // catch sees convertCancelled and restores the offer.
  resetFfmpeg();
}
