// ── In-browser conversion to H.264 MP4 (ffmpeg.wasm) ──
//
// The overlay pipeline's only decoder is the <video> element, so footage the
// browser cannot decode has to become H.264 before anything downstream can
// touch it. In practice that means H.265/HEVC, which only Chrome and Edge play
// (see "Video codec support" in docs/video-overlay.md), and containers no browser opens
// (AVI, MPEG-TS, sometimes Matroska), where H.264 is only copied into MP4.
// ffmpeg.wasm does it locally, so the footage never leaves the machine.
//
// The same converter also makes a smaller copy of footage above 1080p that the
// browser does play (the "hires" banner over the preview), because decoding 4K
// is what makes scrubbing and exporting slow.
//
// The scripts are vendored like every other library, but the 30.7 MB core
// binary is the one exception to the "no CDN" rule in CLAUDE.md (docs/offline-and-storage.md): committing it
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

// Resolutions the converter can scale down to (short side, so portrait works
// the same way). Matches EXPORT_RES_CAPS in video.js.
var CONVERT_RES_CAPS = [1080, 720];

// Quality is x264's CRF: lower is better and bigger. The encode time barely
// changes between them, since decoding is most of the work.
var CONVERT_CRF = { low: 28, standard: 23, high: 18 };
var CONVERT_QUALITIES = ['low', 'standard', 'high'];

// libx264 at `ultrafast`: the only preset that finishes in minutes rather than
// the better part of an hour in a single-threaded wasm build, and the quality
// is fine for footage that is about to be re-encoded again on export anyway.
// The first audio track is kept as AAC (the `?` makes it optional, so a silent
// file still converts); AAC rather than a copy because AVI usually carries PCM
// or MP3, which MP4 players handle badly.
var FFMPEG_AUDIO_ARGS = ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '160k'];

function ffmpegEncodeArgs(cap, crf) {
  var args = ['-map', '0:v:0'];
  if (cap) args.push('-vf', ffmpegScaleFilter(cap));
  return args.concat(['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf), '-pix_fmt', 'yuv420p']);
}

// H.264 that is only in the wrong container (AVI, MPEG-TS, Matroska) is copied
// into MP4 as-is: seconds rather than minutes, and no quality loss. genpts
// because AVI carries no timestamps of its own. Falls back to the re-encode if
// ffmpeg refuses the copy.
var FFMPEG_REMUX_ARGS = ['-map', '0:v:0', '-c:v', 'copy'];

// Scales the short side down to cap, never up, to even sizes (x264 needs them).
// The commas sit inside quotes, so the filtergraph parser does not split on them.
function ffmpegScaleFilter(cap) {
  var k = 'min(1,' + cap + '/min(iw,ih))';
  return "scale=w='trunc(iw*" + k + "/2)*2':h='trunc(ih*" + k + "/2)*2'";
}

// Observed throughput, in wall-clock seconds per second of video, persisted in
// the `settings` object store. ffmpeg.wasm is single-threaded, so this tracks
// single-core clock speed and varies several-fold between machines: measured
// ~6x on the dev desktop, and a throttling laptop can be 2-3x worse. Hence a
// stored per-machine figure rather than a constant.
//
// Kept per source codec, because decode cost is most of the work and differs
// several-fold between codecs (HEVC against MJPEG or MPEG-4 Part 2). HEVC keeps
// its original key so calibrations made before this split survive.
//
// Stored as 1080p-equivalent work (see convertWorkFactor), so a 4K clip or a
// downscale does not throw off the next estimate.
var CONVERT_RATE_KEY = 'hevcConvertRate';
var HEVC_FOURCC = ['hev1', 'hvc1', 'dvh1', 'dvhe'];

function convertRateKey(fourcc) {
  if (HEVC_FOURCC.indexOf(fourcc) >= 0) return CONVERT_RATE_KEY;
  return fourcc ? 'convertRate:' + fourcc : null;
}

// How much work a conversion is relative to 1080p in, 1080p out. Measured on
// 1080p HEVC: decode is 55% of the time and scales with the source's pixels,
// encode is 45% and scales with the output's. 1 when the size is unknown.
var CONVERT_REF_PIXELS = 1920 * 1080;
function convertWorkFactor(srcW, srcH, cap) {
  if (!srcW || !srcH) return 1;
  var out = convertOutputSize(srcW, srcH, cap);
  return 0.55 * (srcW * srcH) / CONVERT_REF_PIXELS + 0.45 * (out.width * out.height) / CONVERT_REF_PIXELS;
}

function convertOutputSize(w, h, cap) {
  var shortSide = Math.min(w, h);
  if (!cap || shortSide <= cap) return { width: w, height: h };
  var k = cap / shortSide;
  return { width: Math.round(w * k / 2) * 2, height: Math.round(h * k / 2) * 2 };
}

// Only H.264 in a foreign container, kept at its own size, can be copied
// rather than re-encoded.
function convertModeFor(codec, cap) {
  return codec && codec.container && codec.fourcc === 'avc1' && !cap ? 'remux' : 'encode';
}

// Throughput range used only for the first-run estimate, before this machine
// has measured itself. The low end is the dev desktop (~4.2x measured); the
// high end allows for a laptop running 2-3x slower on battery. Stated as a
// range because a single number would be wrong on unknown hardware, and a
// wrong number is worse than an honest span.
var CONVERT_RATE_LOW = 4;
var CONVERT_RATE_HIGH = 15;

var ffmpegInstance = null;
var ffmpegLoading = null;
// The offer currently shown, in one of the two panels:
// { panel, kind: 'fix'|'hires', file, codec, srcW, srcH, durationSec, rate }
// `codec` is { fourcc, codecName, container? }, kept for re-rendering.
var convertJob = null;
var convertEtaSmoothed = null;
var convertRunning = false;
var convertCancelled = false;
// Bumped by every start and every cancel. A run whose id is no longer current
// was cancelled: ffmpeg.wasm's load() may never settle once its worker is
// terminated, so a cancel cannot wait for the run to unwind and resets the
// state itself; the stale run then returns without touching anything.
var convertRunId = 0;
// Rolling tail of ffmpeg's stderr, so a non-zero exit can name its own reason
// ("Invalid data found when processing input") instead of surfacing the
// downstream "FS error" from reading an output file that was never written.
var ffmpegLogTail = [];

// A container no browser opens is worth converting whatever its codec, since
// ffmpeg reads far more than the browser does.
function canOfferVideoConvert(fourcc, container) {
  return (!!container || CONVERTIBLE_FOURCC.indexOf(fourcc) >= 0) && canRunVideoConvert();
}

// Whether ffmpeg.wasm can run here at all.
function canRunVideoConvert() {
  return location.protocol !== 'file:' &&
    typeof Worker !== 'undefined' &&
    typeof WebAssembly !== 'undefined';
}

// The command the user would run themselves, shown in the panel's details
// block. Uses a slower preset than we do, since native ffmpeg can afford it.
function ffmpegManualCommand(name) {
  return 'ffmpeg -i "' + name + '" -c:v libx264 -crf 20 -c:a aac -movflags +faststart out.mp4';
}

function convertedFileName(name, cap) {
  return name.replace(/\.[^.\/\\]+$/, '') + (cap ? ' (' + cap + 'p)' : ' (H.264)') + '.mp4';
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
    // The wasm build works on its own input path; the user knows their own name.
    return line.replace(/^(in\.[A-Za-z0-9]+|\/in\/[^:]+):\s*/, '');
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

// Makes the input readable by ffmpeg. WORKERFS reads the File in place, so a
// multi-GB 4K clip is never copied into wasm memory (which caps at a few GB
// and holds the output too). Falls back to copying it in where mounting fails.
async function stageFfmpegInput(ff, file) {
  try {
    try { await ff.createDir('/in'); } catch (e) {}
    await ff.mount('WORKERFS', { files: [file] }, '/in');
    return {
      path: '/in/' + file.name,
      cleanup: async function() {
        try { await ff.unmount('/in'); } catch (e) {}
        try { await ff.deleteDir('/in'); } catch (e) {}
      },
    };
  } catch (e) {
    console.warn('[FlySight] WORKERFS mount failed, copying the file in', e);
    var ext = /\.([A-Za-z0-9]+)$/.exec(file.name);
    var name = 'in.' + (ext ? ext[1].toLowerCase() : 'mp4');
    await ff.writeFile(name, new Uint8Array(await file.arrayBuffer()));
    return {
      path: name,
      cleanup: async function() { try { await ff.deleteFile(name); } catch (e2) {} },
    };
  }
}

// opts: { mode: 'remux'|'encode', cap: short side or 0, crf }
async function convertVideoToH264(file, hooks, opts) {
  var stage = function(name) { if (hooks && hooks.onStage) hooks.onStage(name); };
  stage('loading');
  var ff = await ensureFfmpeg();

  var outName = 'out.mp4';
  var onProgress = function(e) {
    if (hooks && hooks.onProgress) hooks.onProgress(e && e.progress);
  };
  ff.on('progress', onProgress);
  stage('reading');
  var input = await stageFfmpegInput(ff, file);
  var outFile = function(data) {
    var f = new File([data], convertedFileName(file.name, opts.cap), { type: 'video/mp4' });
    // So the hires banner is not offered again for our own output.
    f.flysightConverted = true;
    return f;
  };
  // exec() resolves with ffmpeg's exit code instead of rejecting, so a failure
  // has to be turned into an error by hand. Without that the first symptom is
  // an opaque "FS error" from reading an output that was never written.
  var run = async function(videoArgs, withAudio, pre) {
    ffmpegLogTail = [];
    var args = (pre || []).concat(['-i', input.path], videoArgs,
      withAudio ? FFMPEG_AUDIO_ARGS : ['-an'], ['-movflags', '+faststart', outName]);
    var code = await ff.exec(args);
    var data = code === 0 ? await ff.readFile(outName).catch(function() { return null; }) : null;
    try { await ff.deleteFile(outName); } catch (e) {}
    return data && data.length ? data : null;
  };
  try {
    if (opts.mode === 'remux') {
      stage('remuxing');
      var remuxed = await run(FFMPEG_REMUX_ARGS, true, ['-fflags', '+genpts']);
      if (remuxed) return outFile(remuxed);
      console.warn('[FlySight] remux failed, re-encoding instead', ffmpegFailureReason(''));
    }
    stage('encoding');
    var encodeArgs = ffmpegEncodeArgs(opts.cap, opts.crf);
    var data = await run(encodeArgs, true);
    if (!data && !convertCancelled) {
      // An audio track ffmpeg cannot decode should not cost the user the
      // video, so try once more without it.
      var reason = ffmpegFailureReason('');
      console.warn('[FlySight] conversion with audio failed, retrying without', reason);
      stage('encoding');
      data = await run(encodeArgs, false);
      if (!data) throw new Error(ffmpegFailureReason(reason || 'ffmpeg could not convert this file'));
    }
    if (!data) throw new Error('the conversion produced no data');
    return outFile(data);
  } finally {
    try { ff.off('progress', onProgress); } catch (e) {}
    // Frees the wasm-side copy or mount. Throws if the worker is already gone.
    try { await input.cleanup(); } catch (e) {}
  }
}

// ── Panel UI ──
// Two panels share this code: #videoConvertPanel in step 1 (the file cannot be
// played, so converting is the only way on) and #videoHiresPanel over the
// preview (the file plays but is above 1080p). Their parts are found by
// data-vc attributes, so both use the same markup inside.

function vcPart(panel, name) {
  return panel ? panel.querySelector('[data-vc="' + name + '"]') : null;
}

// `info` is { fourcc, codecName } for an MP4/MOV track, plus `container` and
// `durationSec` when it came from sniffContainer() in video.js, and `width` /
// `height` when the header says.
function showVideoConvertOffer(file, info) {
  var panel = document.getElementById('videoConvertPanel');
  if (!panel) return;
  var job = startConvertOffer(panel, 'fix', file, info);
  document.getElementById('videoConvertCmd').textContent = ffmpegManualCommand(file.name);

  // Deliberately not awaited: the codec message is the urgent part, and neither
  // read must delay the panel. The estimate line fills in when they land.
  // mvhd only exists in MP4/MOV; the other containers' sniff brought its own.
  var rateKey = convertRateKey(info.fourcc);
  Promise.all([
    info.container ? info.durationSec || null
      : typeof readMp4DurationSec === 'function' ? readMp4DurationSec(file) : null,
    rateKey && typeof getSetting === 'function' ? getSetting(rateKey) : null,
    info.width || info.container || typeof readMp4TrackInfo !== 'function' ? null : readMp4TrackInfo(file),
  ]).then(function(r) {
    // Dismissed, or a different file arrived while we were reading.
    if (convertJob !== job) return;
    job.durationSec = r[0];
    job.rate = r[1];
    if (r[2] && r[2].width) { job.srcW = r[2].width; job.srcH = r[2].height; }
    renderConvertOptions();
    renderConvertOfferText();
  }).catch(function() {});
}

// The playable-but-above-1080p offer. w×h comes from the loaded <video>.
function showVideoHiresOffer(file, w, h) {
  var panel = document.getElementById('videoHiresPanel');
  if (!panel || !canRunVideoConvert()) return;
  var job = startConvertOffer(panel, 'hires', file, { fourcc: null, codecName: null, width: w, height: h });
  // The video is loaded, so its duration is known; the codec comes from the
  // header and keys the throughput calibration like the step-1 offer.
  var video = document.getElementById('videoPreview');
  job.durationSec = video && video.duration > 0 ? video.duration : null;
  if (typeof sniffVideoTrackFourcc === 'function') {
    sniffVideoTrackFourcc(file).then(function(fourcc) {
      if (convertJob === job && fourcc) job.codec.fourcc = fourcc;
    }).catch(function() {});
  }
}

function startConvertOffer(panel, kind, file, info) {
  if (convertJob && convertJob.panel !== panel) hideConvertPanel(convertJob.panel);
  convertJob = {
    panel: panel, kind: kind, file: file,
    codec: { fourcc: info.fourcc, codecName: info.codecName, container: info.container || null },
    srcW: info.width || null, srcH: info.height || null,
    durationSec: null, rate: null,
  };
  renderConvertOptions();
  renderConvertOfferText();
  vcPart(panel, 'actions').style.display = '';
  vcPart(panel, 'progress').style.display = 'none';
  vcPart(panel, 'go').disabled = false;
  panel.style.display = '';
  return convertJob;
}

function convertSizeLabel(w, h) { return w + ' × ' + h; }

// Fills the resolution and quality selects, keeping the user's picks where
// they still exist. The step-1 panel offers Original first; the hires banner
// only offers the smaller sizes, since Original is its "Keep" button.
function renderConvertOptions() {
  var job = convertJob;
  if (!job) return;
  var resSel = vcPart(job.panel, 'res');
  var qSel = vcPart(job.panel, 'quality');
  var prevRes = resSel.value;
  var prevQ = qSel.value || 'standard';
  resSel.innerHTML = '';
  var add = function(sel, value, label) {
    var opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  };
  var w = job.srcW, h = job.srcH;
  if (job.kind === 'fix') {
    add(resSel, '0', w ? t('video.resOriginal', { res: convertSizeLabel(w, h) }) : t('convert.resOriginalPlain'));
  }
  CONVERT_RES_CAPS.forEach(function(cap) {
    // Unknown size: offer every cap, the filter never scales up anyway.
    if (w && Math.min(w, h) <= cap) return;
    var out = w ? convertOutputSize(w, h, cap) : null;
    add(resSel, String(cap), out ? cap + 'p (' + convertSizeLabel(out.width, out.height) + ')' : cap + 'p');
  });
  if (resSel.querySelector('option[value="' + prevRes + '"]')) resSel.value = prevRes;
  qSel.innerHTML = '';
  CONVERT_QUALITIES.forEach(function(q) { add(qSel, q, t('video.quality_' + q)); });
  qSel.value = prevQ;
  var keep = vcPart(job.panel, 'keep');
  if (keep && w) keep.textContent = t('convert.keep', { res: convertSizeLabel(w, h) });
}

function convertSelectedCap() {
  var sel = convertJob && vcPart(convertJob.panel, 'res');
  return sel ? Number(sel.value) || 0 : 0;
}

function convertSelectedCrf() {
  var sel = convertJob && vcPart(convertJob.panel, 'quality');
  return CONVERT_CRF[sel && sel.value] || CONVERT_CRF.standard;
}

// On Windows, Chrome and Edge play H.265 once the OS has a decoder, which the
// free "HEVC Video Extensions from Device Manufacturer" supply. Microsoft
// hides that package from the Store search, so the link points at the
// download page the user chose (Uptodown) rather than a Store search.
var HEVC_EXTENSION_URL = 'https://hevc-video-extensions-from-device-manufacturer.en.uptodown.com/windows';

function isWindowsPlatform() {
  var uad = navigator.userAgentData;
  if (uad && uad.platform) return uad.platform === 'Windows';
  return /Windows/.test(navigator.userAgent);
}

// The "or play it directly" line under the step-1 offer: H.265 on Windows
// only, since the extension does nothing elsewhere or for other codecs. Built
// from DOM nodes so the translated sentence can carry the link.
function renderHevcExtensionTip(job) {
  var el = vcPart(job.panel, 'hevcTip');
  if (!el) return;
  var show = !job.codec.container && HEVC_FOURCC.indexOf(job.codec.fourcc) >= 0 && isWindowsPlatform();
  el.style.display = show ? '' : 'none';
  if (!show) return;
  var parts = t('convert.hevcTip').split('{link}');
  var a = document.createElement('a');
  a.href = HEVC_EXTENSION_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = t('convert.hevcTipLink');
  el.replaceChildren(document.createTextNode(parts[0] || ''), a, document.createTextNode(parts[1] || ''));
}

// The message and the estimate are set from JS, so they are rendered through
// one function that refreshVideoConvertLang() can call again.
function renderConvertOfferText() {
  var job = convertJob;
  if (!job) return;
  var msg = vcPart(job.panel, 'msg');
  var eta = vcPart(job.panel, 'eta');
  var c = job.codec;
  if (job.kind === 'hires') {
    msg.textContent = t('convert.hiresOffer', { res: convertSizeLabel(job.srcW, job.srcH) });
    return;
  }
  renderHevcExtensionTip(job);
  msg.textContent = c.container
    ? t('convert.offerContainer', {
        container: CONTAINER_NAMES[c.container],
        codec: c.codecName || '?',
        mb: FFMPEG_CORE_MB,
      })
    : t('convert.offer', {
        codec: c.codecName || c.fourcc,
        fourcc: c.fourcc,
        mb: FFMPEG_CORE_MB,
      });
  if (!eta) return;
  var cap = convertSelectedCap();
  if (convertModeFor(c, cap) === 'remux') {
    // Copying is bounded by reading the file, so no per-clip figure is needed.
    eta.textContent = t('convert.etaRemux');
    eta.style.display = '';
    return;
  }
  // The first-run range was measured on HEVC; for other codecs it would be
  // wrong by a wide margin, so they wait for their own calibration and rely on
  // the live countdown until then.
  if (!job.durationSec ||
      (!job.rate && convertRateKey(c.fourcc) !== CONVERT_RATE_KEY)) {
    // No duration means no honest estimate, so say nothing rather than guess.
    eta.textContent = '';
    eta.style.display = 'none';
    return;
  }
  var work = job.durationSec * convertWorkFactor(job.srcW, job.srcH, cap);
  var secs = Math.round(job.durationSec);
  eta.textContent = job.rate
    ? t('convert.etaKnown', { time: formatConvertDuration(work * job.rate), secs: secs })
    : t('convert.etaUnknown', {
        low: formatConvertDuration(work * CONVERT_RATE_LOW),
        high: formatConvertDuration(work * CONVERT_RATE_HIGH),
        secs: secs,
      });
  eta.style.display = '';
}

// The estimate follows the chosen size.
document.addEventListener('change', function(e) {
  if (convertJob && e.target === vcPart(convertJob.panel, 'res')) renderConvertOfferText();
});

// Called from applyLanguage() so a live language switch re-renders the panel.
function refreshVideoConvertLang() {
  if (convertJob && convertJob.panel.style.display !== 'none') {
    renderConvertOptions();
    renderConvertOfferText();
  }
}

function hideConvertPanel(panel) {
  if (panel) panel.style.display = 'none';
}

// Clears both offers (a new file was dropped, or the modal closed), stopping
// a conversion in progress so its result cannot replace the new file.
function hideVideoConvertOffer() {
  if (convertRunning) cancelVideoConvert();
  convertJob = null;
  hideConvertPanel(document.getElementById('videoConvertPanel'));
  hideConvertPanel(document.getElementById('videoHiresPanel'));
}

// The hires banner's "Keep 3840 × 2160" button.
function hideVideoHiresOffer() {
  if (convertJob && convertJob.kind === 'hires') {
    if (convertRunning) cancelVideoConvert();
    convertJob = null;
  }
  hideConvertPanel(document.getElementById('videoHiresPanel'));
}

function setConvertStatus(text, pct) {
  var panel = convertJob && convertJob.panel;
  var el = vcPart(panel, 'status');
  if (el) el.textContent = text;
  if (pct != null) {
    var fill = vcPart(panel, 'fill');
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

function showConvertOfferActions(panel) {
  var prog = vcPart(panel, 'progress');
  var actions = vcPart(panel, 'actions');
  if (prog) prog.style.display = 'none';
  if (actions) actions.style.display = '';
}

async function startVideoConvert() {
  if (convertRunning || !convertJob) return;
  var job = convertJob;
  var panel = job.panel;
  var file = job.file;
  var runId = ++convertRunId;
  convertRunning = true;
  convertCancelled = false;
  // The hires banner sits over a playing preview; decoding 4K alongside the
  // conversion only slows both down, and the copy replaces it anyway.
  if (job.kind === 'hires') {
    var preview = document.getElementById('videoPreview');
    if (preview && !preview.paused) preview.pause();
  }

  vcPart(panel, 'actions').style.display = 'none';
  vcPart(panel, 'progress').style.display = '';
  vcPart(panel, 'cancel').disabled = false;
  setConvertStatus(t('convert.loading', { mb: FFMPEG_CORE_MB }), 0);

  var startedAt = Date.now();
  var encodeStartedAt = null;
  var cap = convertSelectedCap();
  var crf = convertSelectedCrf();
  var mode = convertModeFor(job.codec, cap);
  var rateKey = convertRateKey(job.codec.fourcc);
  var work = job.durationSec ? job.durationSec * convertWorkFactor(job.srcW, job.srcH, cap) : null;
  convertEtaSmoothed = null;

  try {
    var out = await convertVideoToH264(file, {
      onStage: function(name) {
        if (name === 'loading') setConvertStatus(t('convert.loading', { mb: FFMPEG_CORE_MB }), 0);
        else if (name === 'reading') setConvertStatus(t('convert.reading'), 0);
        else if (name === 'remuxing') setConvertStatus(t('convert.remuxing'), 0);
        else {
          encodeStartedAt = Date.now();
          convertEtaSmoothed = null;
          setConvertStatus(t('convert.encoding', { pct: 0, elapsed: convertElapsed(startedAt) }), 0);
        }
      },
      onProgress: function(p) {
        var pct = Math.round((p || 0) * 100);
        // A remux is over in seconds; the bar is enough, no countdown.
        if (!encodeStartedAt) { setConvertStatus(t('convert.remuxing'), pct); return; }
        var elapsed = (Date.now() - encodeStartedAt) / 1000;
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
    }, { mode: mode, cap: cap, crf: crf });
    if (runId !== convertRunId) return;

    // Record throughput for the next offer's up-front estimate, as
    // 1080p-equivalent work. Measured over the encode phase only: the core
    // download and the file read are roughly constant rather than proportional
    // to clip length, so leaving them out makes the figure more accurate.
    // Overwritten rather than averaged, so it tracks the machine's current
    // state. A remux never reaches the encode stage, so it is never recorded.
    if (encodeStartedAt && rateKey && work > 0 && typeof setSetting === 'function') {
      var rate = ((Date.now() - encodeStartedAt) / 1000) / work;
      if (rate > 0 && rate < 600) setSetting(rateKey, rate);
    }

    console.info('[FlySight] converted to H.264', {
      from: file.name, fromSize: file.size, toSize: out.size, mode: encodeStartedAt ? 'encode' : 'remux',
      cap: cap, crf: crf, clipSeconds: job.durationSec && Math.round(job.durationSec),
      seconds: Math.round((Date.now() - startedAt) / 1000),
    });
    convertRunning = false;
    var kind = job.kind;
    hideVideoConvertOffer();
    // The hires copy keeps the same timeline, so the marked exit and crop stay.
    if (kind === 'hires' && typeof loadVideoIntoPreview === 'function') loadVideoIntoPreview(out, { keepSync: true });
    else handleVideoFile(out);
  } catch (e) {
    if (runId !== convertRunId) return;
    resetFfmpeg();
    console.warn('[FlySight] conversion failed', e);
    showConvertOfferActions(panel);
    alert(t('convert.failed', { msg: convertErrorMessage(e) }));
  } finally {
    if (runId === convertRunId) convertRunning = false;
  }
}

function cancelVideoConvert() {
  if (!convertRunning) return;
  convertCancelled = true;
  convertRunId++;
  convertRunning = false;
  // Kills the worker mid-encode or mid-load. The pending run sees its id is
  // stale and returns quietly; the offer is restored here so it can be retried.
  resetFfmpeg();
  if (convertJob) showConvertOfferActions(convertJob.panel);
}
