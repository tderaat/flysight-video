// ── ZIP writer ──
// A minimal ZIP builder for "Download all jump files": no dependency, so the
// app stays vendored-only and works offline. Each entry is deflated with the
// browser's own CompressionStream('deflate-raw') (CSVs shrink 5-10x), and
// stored uncompressed where that API is missing or deflating doesn't help.
// No ZIP64: a season of jumps stays far below the 4 GB / 65,535-entry limits.
const ZIP_FLAG_UTF8 = 0x0800;   // general-purpose bit 11: names are UTF-8
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_VERSION = 20;         // 2.0, the baseline that has deflate

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function zipCrc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Raw deflate (no zlib header), which is exactly what ZIP method 8 stores.
// Returns null when the browser can't do it, so the caller stores instead.
async function zipDeflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    return null;
  }
}

// MS-DOS date/time as ZIP stores it: local wall-clock time, 2 s resolution,
// years 1980-2107.
function zipDosDateTime(d) {
  if (!(d instanceof Date) || isNaN(d)) d = new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{ path, data: string | Uint8Array, date?: Date }], paths using '/'.
// Returns a Blob of type application/zip. The parts are handed to the Blob
// constructor as-is, so the archive is never copied into one big buffer here.
async function buildZip(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const crc = zipCrc32(raw);
    const deflated = await zipDeflateRaw(raw);
    const useDeflate = deflated !== null && deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE;
    const { time, date } = zipDosDateTime(entry.date);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034B50, true);   // local file header signature
    local.setUint16(4, ZIP_VERSION, true);
    local.setUint16(6, ZIP_FLAG_UTF8, true);
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);            // extra field length
    parts.push(new Uint8Array(local.buffer), name, body);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014B50, true);     // central directory signature
    dir.setUint16(4, ZIP_VERSION, true);     // version made by
    dir.setUint16(6, ZIP_VERSION, true);     // version needed
    dir.setUint16(8, ZIP_FLAG_UTF8, true);
    dir.setUint16(10, method, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, name.length, true);
    // 30-41: extra/comment length, disk number, internal/external attributes, all 0
    dir.setUint32(42, offset, true);         // offset of the local header
    central.push(new Uint8Array(dir.buffer), name);

    offset += 30 + name.length + body.length;
  }

  const centralSize = central.reduce((sum, p) => sum + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054B50, true);       // end of central directory signature
  end.setUint16(8, entries.length, true);    // entries on this disk
  end.setUint16(10, entries.length, true);   // entries in total
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);           // central directory offset
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
