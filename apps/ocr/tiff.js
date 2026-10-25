// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// TIFF, the format of scanners and fax: browsers do not decode it, so the
// pages of a TIFF file are decoded here, one at a time, into RGBA pixels.
// Classic TIFF in either byte order, every page (reduced-resolution copies are
// skipped), strips or tiles, contiguous or separate planes, 1 to 16 bits per
// sample, bilevel, grey, palette, RGB and CMYK, with or without alpha, the
// orientation tag, and these compressions: none, PackBits, LZW, Deflate,
// CCITT modified Huffman, Group 3 (1D and 2D) and Group 4, and JPEG (decoded
// by the browser through `decodeJpeg`). Anything else is refused with
// `unsupported-format`; a broken file with `decode-failed`. No imports.

const fail = (code, message) => Object.assign(new Error(message), { code });

/** Largest page decoded, in pixels (the RGBA copy is four bytes each). */
export const MAX_PIXELS = 64 * 1024 * 1024;

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

/**
 * The pages of a TIFF file, read from its directories (nothing decoded yet).
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{ little: boolean, pages: object[] }}
 */
export function tiffPages(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 8) throw fail('decode-failed', 'too short for a TIFF file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const order = String.fromCharCode(bytes[0], bytes[1]);
  if (order !== 'II' && order !== 'MM') throw fail('decode-failed', 'not a TIFF file');
  const little = order === 'II';
  const magic = dv.getUint16(2, little);
  if (magic === 43) throw fail('unsupported-format', 'BigTIFF is not supported');
  if (magic !== 42) throw fail('decode-failed', 'not a TIFF file');
  const u16 = o => dv.getUint16(o, little), u32 = o => dv.getUint32(o, little);
  const pages = [];
  const seen = new Set();
  let ifd = u32(4);
  while (ifd && pages.length < 10000) {
    if (seen.has(ifd) || ifd + 2 > bytes.length) break;
    seen.add(ifd);
    const n = u16(ifd);
    if (ifd + 2 + n * 12 + 4 > bytes.length) throw fail('decode-failed', 'a TIFF directory runs past the end of the file');
    const tags = new Map();
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = TYPE_SIZE[type];
      if (!size) continue;
      const total = size * count;
      const at = total <= 4 ? e + 8 : u32(e + 8);
      if (at + total > bytes.length) continue;
      tags.set(tag, readValues(dv, bytes, type, count, at, little));
    }
    const page = describe(tags);
    page.little = little;
    if (!(page.subfileType & 1)) pages.push(page);
    ifd = u32(ifd + 2 + n * 12);
  }
  if (!pages.length) throw fail('decode-failed', 'the TIFF file has no image');
  return { little, pages };
}

function readValues(dv, bytes, type, count, at, little) {
  if (type === 2) return String.fromCharCode(...bytes.subarray(at, at + count)).replace(/\0+$/, '');
  if (type === 7 || type === 1) return bytes.slice(at, at + count);
  const out = [];
  for (let i = 0; i < count; i++) {
    switch (type) {
      case 3: out.push(dv.getUint16(at + 2 * i, little)); break;
      case 4: case 13: out.push(dv.getUint32(at + 4 * i, little)); break;
      case 5: out.push(dv.getUint32(at + 8 * i, little) / (dv.getUint32(at + 8 * i + 4, little) || 1)); break;
      case 6: out.push(dv.getInt8(at + i)); break;
      case 8: out.push(dv.getInt16(at + 2 * i, little)); break;
      case 9: out.push(dv.getInt32(at + 4 * i, little)); break;
      case 10: out.push(dv.getInt32(at + 8 * i, little) / (dv.getInt32(at + 8 * i + 4, little) || 1)); break;
      case 11: out.push(dv.getFloat32(at + 4 * i, little)); break;
      case 12: out.push(dv.getFloat64(at + 8 * i, little)); break;
      default: break;
    }
  }
  return out;
}

const first = (tags, tag, dflt) => { const v = tags.get(tag); return v == null ? dflt : (Array.isArray(v) ? v[0] : v[0] ?? dflt); };
const list = (tags, tag) => { const v = tags.get(tag); return v == null ? null : Array.from(v); };

function describe(tags) {
  const spp = first(tags, 277, 1);
  const bps = list(tags, 258) || [1];
  const compression = first(tags, 259, 1);
  return {
    width: first(tags, 256, 0),
    height: first(tags, 257, 0),
    bitsPerSample: bps.length >= spp ? bps.slice(0, spp) : Array(spp).fill(bps[0]),
    samplesPerPixel: spp,
    compression,
    // Fax images without the tag are white on zero, as fax data is.
    photometric: first(tags, 262, compression >= 2 && compression <= 4 ? 0 : 1),
    fillOrder: first(tags, 266, 1),
    orientation: first(tags, 274, 1),
    rowsPerStrip: first(tags, 278, 0xffffffff),
    planar: first(tags, 284, 1),
    t4Options: first(tags, 292, 0),
    t6Options: first(tags, 293, 0),
    predictor: first(tags, 317, 1),
    colorMap: list(tags, 320),
    tileWidth: first(tags, 322, 0),
    tileLength: first(tags, 323, 0),
    offsets: list(tags, 324) || list(tags, 273) || [],
    counts: list(tags, 325) || list(tags, 279) || [],
    tiled: tags.has(324),
    extraSamples: list(tags, 338) || [],
    sampleFormat: first(tags, 339, 1),
    inkSet: first(tags, 332, 1),
    jpegTables: tags.get(347) instanceof Uint8Array ? tags.get(347) : null,
    subfileType: first(tags, 254, 0),
  };
}

// ── decompression ──────────────────────────────────────────────────────────

/** Reverse the bit order of every byte (FillOrder 2). */
export function reverseBits(src) {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let b = src[i];
    b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
    b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
    b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
    out[i] = b;
  }
  return out;
}

/** PackBits. */
export function unpackBits(src, expected) {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (i < src.length && o < expected) {
    const h = src[i] > 127 ? src[i] - 256 : src[i];
    i++;
    if (h >= 0) { const n = Math.min(h + 1, expected - o, src.length - i); out.set(src.subarray(i, i + n), o); i += h + 1; o += n; }
    else if (h !== -128) { const n = Math.min(1 - h, expected - o); out.fill(src[i] ?? 0, o, o + n); i++; o += n; }
  }
  return out;
}

/** TIFF LZW: codes of 9 to 12 bits, most significant bit first, early change. */
export function unLzw(src, expected) {
  const out = new Uint8Array(expected);
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), length = new Int32Array(4096), firstOf = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; length[i] = 1; firstOf[i] = i; }
  let next = 258, width = 9, prev = -1, o = 0, bitPos = 0;
  const totalBits = src.length * 8;
  const write = code => {
    const len = length[code];
    let end = o + len, c = code;
    for (let k = end - 1; k >= o; k--) { if (k < expected) out[k] = suffix[c]; c = prefix[c]; }
    o = end;
  };
  while (bitPos + width <= totalBits && o < expected) {
    let code = 0;
    for (let k = 0; k < width; k++) { const bit = (src[(bitPos + k) >> 3] >> (7 - ((bitPos + k) & 7))) & 1; code = (code << 1) | bit; }
    bitPos += width;
    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; prev = -1; continue; }
    if (prev < 0) {
      if (code > 255) throw fail('decode-failed', 'bad LZW data');
      write(code); prev = code; continue;
    }
    let firstChar;
    if (code < next) { write(code); firstChar = firstOf[code]; }
    else if (code === next) { firstChar = firstOf[prev]; }
    else throw fail('decode-failed', 'bad LZW code');
    if (next < 4096) {
      prefix[next] = prev; suffix[next] = firstChar; length[next] = length[prev] + 1; firstOf[next] = firstOf[prev];
      if (code === next) write(next);
      next++;
      if (next === 511) width = 10; else if (next === 1023) width = 11; else if (next === 2047) width = 12;
    } else if (code === next) throw fail('decode-failed', 'LZW table overflow');
    prev = code;
  }
  return out;
}

/** zlib (Adobe Deflate) with the platform's DecompressionStream. */
export async function inflate(src) {
  if (typeof DecompressionStream === 'undefined') throw fail('unsupported-format', 'this browser cannot inflate Deflate data');
  try {
    const stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    throw Object.assign(fail('decode-failed', 'bad Deflate data'), { cause: err });
  }
}

// ── CCITT (fax) ────────────────────────────────────────────────────────────

const WHITE_TERM = ['00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111', '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101', '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100', '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010', '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000', '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010', '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000', '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100'];
const WHITE_MAKEUP = ['11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101', '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100', '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001', '010011010', '011000', '010011011'];
const BLACK_TERM = ['0000110111', '010', '11', '10', '011', '0011', '0010', '00011', '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000', '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000', '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001', '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111', '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111'];
const BLACK_MAKEUP = ['0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100', '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100', '0000001100101'];
const EXT_MAKEUP = ['00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101', '000000010110', '000000010111', '000000011100', '000000011101', '000000011110', '000000011111'];
const MODES = { '0001': 'P', '001': 'H', '1': 0, '011': 1, '000011': 2, '0000011': 3, '010': -1, '000010': -2, '0000010': -3 };

function codeTable(entries) {
  const t = new Map();
  for (const [bits, value] of entries) t.set(bits.length * 65536 + parseInt(bits, 2), value);
  return t;
}
const RUNS = [
  codeTable([...WHITE_TERM.map((c, i) => [c, i]), ...WHITE_MAKEUP.map((c, i) => [c, (i + 1) * 64]), ...EXT_MAKEUP.map((c, i) => [c, 1792 + i * 64])]),
  codeTable([...BLACK_TERM.map((c, i) => [c, i]), ...BLACK_MAKEUP.map((c, i) => [c, (i + 1) * 64]), ...EXT_MAKEUP.map((c, i) => [c, 1792 + i * 64])]),
];
const MODE_TABLE = codeTable(Object.entries(MODES));

class Bits {
  constructor(src) { this.src = src; this.pos = 0; this.end = src.length * 8; }
  bit() { if (this.pos >= this.end) return -1; const b = (this.src[this.pos >> 3] >> (7 - (this.pos & 7))) & 1; this.pos++; return b; }
  peek(n) { let v = 0; for (let k = 0; k < n; k++) { const p = this.pos + k; v = (v << 1) | (p < this.end ? (this.src[p >> 3] >> (7 - (p & 7))) & 1 : 0); } return v; }
  align() { this.pos = (this.pos + 7) & ~7; }
  /** Read one code of a table; null at the end of the data or on an unknown code. */
  code(table, max) {
    let v = 0;
    for (let n = 1; n <= max; n++) {
      const b = this.bit();
      if (b < 0) return null;
      v = (v << 1) | b;
      const hit = table.get(n * 65536 + v);
      if (hit !== undefined) return hit;
    }
    return null;
  }
  /** Skip zero fill and one end-of-line code if there is one here. True when one was found. */
  eol() {
    const save = this.pos;
    let zeros = 0;
    while (this.pos < this.end && this.peek(1) === 0) { this.pos++; zeros++; }
    if (zeros >= 11 && this.pos < this.end && this.peek(1) === 1) { this.pos++; return true; }
    this.pos = save;
    return false;
  }
}

function run(bits, color) {
  let total = 0;
  for (;;) {
    const v = bits.code(RUNS[color], 13);
    if (v === null) throw fail('decode-failed', 'bad CCITT run code');
    total += v;
    if (v < 64) return total;
  }
}

/** One row coded in one dimension: changing positions. */
function row1D(bits, width) {
  const changes = [];
  let a0 = 0, color = 0;
  while (a0 < width) {
    a0 += run(bits, color);
    changes.push(Math.min(a0, width));
    color ^= 1;
  }
  return changes;
}

/** One row coded in two dimensions against the reference row's changes. */
function row2D(bits, ref, width) {
  const changes = [];
  let a0 = -1, color = 0, p = 0;
  const refAt = k => (k < ref.length ? ref[k] : width);
  while (a0 < width) {
    // b1 may sit one change back after a vertical mode to the left.
    if (p > 0) p--;
    while (p < ref.length && ref[p] <= a0) p++;
    if ((p & 1) !== color) p++;
    const b1 = refAt(p), b2 = refAt(p + 1);
    const mode = bits.code(MODE_TABLE, 7);
    if (mode === null) throw fail('decode-failed', 'bad CCITT mode code');
    if (mode === 'P') { a0 = b2; continue; }
    if (mode === 'H') {
      const start = Math.max(a0, 0);
      const a1 = start + run(bits, color), a2 = a1 + run(bits, color ^ 1);
      changes.push(Math.min(a1, width), Math.min(a2, width));
      a0 = a2;
      continue;
    }
    const a1 = b1 + mode;
    if (a1 < Math.max(a0, 0) || a1 > width) throw fail('decode-failed', 'CCITT vertical mode out of the row');
    changes.push(a1);
    a0 = a1;
    color ^= 1;
  }
  return changes;
}

/**
 * Decode CCITT data to one byte per pixel, 1 where the fax code says black.
 * @param {Uint8Array} src
 * @param {number} width
 * @param {number} rows
 * @param {2|3|4} compression 2 modified Huffman, 3 Group 3, 4 Group 4
 * @param {number} options T4Options or T6Options
 */
export function decodeCcitt(src, width, rows, compression, options = 0) {
  const out = new Uint8Array(width * rows);
  const bits = new Bits(src);
  const twoD = compression === 4 || (compression === 3 && (options & 1));
  let ref = [];
  for (let y = 0; y < rows; y++) {
    let changes;
    if (compression === 2) {
      if (y) bits.align();
      changes = row1D(bits, width);
    } else if (compression === 3) {
      bits.eol();
      const oneD = !twoD || bits.bit() === 1;
      changes = oneD ? row1D(bits, width) : row2D(bits, ref, width);
    } else {
      if (bits.peek(12) === 1) break; // end of facsimile block
      changes = row2D(bits, ref, width);
    }
    let x = 0, color = 0;
    const o = y * width;
    for (const c of changes) {
      const end = Math.min(c, width);
      if (color) out.fill(1, o + x, o + end);
      x = end;
      color ^= 1;
    }
    if (color && x < width) out.fill(1, o + x, o + width);
    ref = changes;
  }
  return out;
}

// ── assembly ───────────────────────────────────────────────────────────────

function checkSupported(page) {
  const { compression, photometric, bitsPerSample: bps, samplesPerPixel: spp, sampleFormat, planar, predictor } = page;
  if (!page.width || !page.height) throw fail('decode-failed', 'the TIFF page has no size');
  if (page.width * page.height > MAX_PIXELS) throw fail('too-large', 'the TIFF page is too large');
  if (![1, 2, 3, 4, 5, 7, 8, 32946, 32773].includes(compression)) throw fail('unsupported-format', `TIFF compression ${compression} is not supported`);
  if (![0, 1, 2, 3, 5, 6].includes(photometric)) throw fail('unsupported-format', `TIFF colour model ${photometric} is not supported`);
  if (sampleFormat !== 1 && sampleFormat !== 2) throw fail('unsupported-format', 'floating-point TIFF samples are not supported');
  if (bps.some(b => ![1, 2, 4, 8, 16].includes(b)) || new Set(bps).size > 1) throw fail('unsupported-format', 'unsupported TIFF sample size');
  if (compression >= 2 && compression <= 4 && (bps[0] !== 1 || spp !== 1)) throw fail('decode-failed', 'CCITT data must be one bit per pixel');
  if (photometric === 6 && compression !== 7) throw fail('unsupported-format', 'YCbCr TIFF is only supported with JPEG');
  if (planar !== 1 && planar !== 2) throw fail('decode-failed', 'bad planar configuration');
  if (predictor !== 1 && predictor !== 2) throw fail('unsupported-format', `TIFF predictor ${predictor} is not supported`);
  if (page.offsets.length !== page.counts.length || !page.offsets.length) throw fail('decode-failed', 'the TIFF page has no data');
}

async function decompress(page, raw, rowBytes, rows, width) {
  const data = page.fillOrder === 2 && page.compression !== 7 ? reverseBits(raw) : raw;
  const expected = rowBytes * rows;
  switch (page.compression) {
    case 1: { const out = new Uint8Array(expected); out.set(data.subarray(0, expected)); return out; }
    case 32773: return unpackBits(data, expected);
    case 5: return unLzw(data, expected);
    case 8: case 32946: { const d = await inflate(data); const out = new Uint8Array(expected); out.set(d.subarray(0, expected)); return out; }
    case 2: case 3: case 4: {
      const px = decodeCcitt(data, width, rows, page.compression, page.compression === 4 ? page.t6Options : page.t4Options);
      // Back to packed bits, the layout every other compression gives.
      const out = new Uint8Array(expected);
      for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) if (px[y * width + x]) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      return out;
    }
    default: throw fail('unsupported-format', 'unsupported TIFF compression');
  }
}

function undoPredictor(buf, rowBytes, rows, samples, bits, little) {
  if (bits === 8) {
    for (let y = 0; y < rows; y++) {
      const o = y * rowBytes;
      for (let i = samples; i < rowBytes; i++) buf[o + i] = (buf[o + i] + buf[o + i - samples]) & 255;
    }
  } else if (bits === 16) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let y = 0; y < rows; y++) {
      const o = y * rowBytes;
      for (let i = samples; i < rowBytes / 2; i++) dv.setUint16(o + 2 * i, (dv.getUint16(o + 2 * i, little) + dv.getUint16(o + 2 * (i - samples), little)) & 0xffff, little);
    }
  } else throw fail('unsupported-format', 'predictor with this sample size');
}

/**
 * Decode one page to RGBA (alpha composited over white, orientation applied).
 * @param {ArrayBuffer|Uint8Array} input the whole file
 * @param {object} page one of tiffPages().pages
 * @param {{ decodeJpeg?: (bytes: Uint8Array) => Promise<{ width: number, height: number, data: Uint8ClampedArray }> }} [opts]
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray }>}
 */
export async function decodeTiffPage(input, page, { decodeJpeg } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const little = page.little !== false;
  checkSupported(page);
  const { width, height, samplesPerPixel: spp, planar } = page;
  const bits = page.bitsPerSample[0];
  const planes = planar === 2 ? spp : 1;
  const perPixel = planar === 2 ? 1 : spp;
  const rowBytes = Math.ceil((width * perPixel * bits) / 8);
  const store = Array.from({ length: planes }, () => new Uint8Array(rowBytes * height));
  const rgbaFromJpeg = page.compression === 7 ? new Uint8ClampedArray(width * height * 4) : null;

  const tileW = page.tiled ? page.tileWidth : width;
  const tileH = page.tiled ? page.tileLength : Math.min(page.rowsPerStrip || height, height);
  if (!tileW || !tileH) throw fail('decode-failed', 'bad TIFF tile size');
  const across = Math.ceil(width / tileW), down = Math.ceil(height / tileH);
  const perPlane = across * down;
  if (page.offsets.length < perPlane * planes) throw fail('decode-failed', 'the TIFF page is missing data');
  for (let plane = 0; plane < planes; plane++) {
    for (let t = 0; t < perPlane; t++) {
      const idx = plane * perPlane + t;
      const off = page.offsets[idx], cnt = page.counts[idx];
      if (off + cnt > bytes.length) throw fail('decode-failed', 'TIFF data runs past the end of the file');
      const raw = bytes.subarray(off, off + cnt);
      const tx = (t % across) * tileW, ty = Math.floor(t / across) * tileH;
      const rows = page.tiled ? tileH : Math.min(tileH, height - ty);
      const cols = page.tiled ? tileW : width;
      if (rgbaFromJpeg) {
        if (!decodeJpeg) throw fail('unsupported-format', 'JPEG-compressed TIFF needs a JPEG decoder');
        const tables = page.jpegTables;
        const jpeg = tables && tables.length > 4 ? concat(tables.subarray(0, tables.length - 2), raw.subarray(2)) : raw;
        let img;
        try { img = await decodeJpeg(jpeg); } catch (err) { throw Object.assign(fail('decode-failed', 'bad JPEG data in the TIFF file'), { cause: err }); }
        for (let y = 0; y < Math.min(rows, img.height, height - ty); y++) {
          for (let x = 0; x < Math.min(cols, img.width, width - tx); x++) {
            const s = (y * img.width + x) * 4, d = ((ty + y) * width + tx + x) * 4;
            rgbaFromJpeg[d] = img.data[s]; rgbaFromJpeg[d + 1] = img.data[s + 1]; rgbaFromJpeg[d + 2] = img.data[s + 2]; rgbaFromJpeg[d + 3] = 255;
          }
        }
        continue;
      }
      const tileRowBytes = Math.ceil((cols * perPixel * bits) / 8);
      const buf = await decompress(page, raw, tileRowBytes, rows, cols);
      if (page.predictor === 2) undoPredictor(buf, tileRowBytes, rows, perPixel, bits, little);
      const dst = store[plane];
      const bitOffset = tx * perPixel * bits;
      for (let y = 0; y < rows && ty + y < height; y++) {
        const visibleBits = Math.min(cols, width - tx) * perPixel * bits;
        copyBits(buf, y * tileRowBytes, dst, (ty + y) * rowBytes, bitOffset, visibleBits);
      }
    }
  }
  const rgba = rgbaFromJpeg || toRgba(page, store, rowBytes, bits, little);
  return orient({ width, height, data: rgba }, page.orientation);
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

/** Copy `count` bits from src (starting at byte s) to dst at byte d plus a bit offset. */
function copyBits(src, s, dst, d, bitOffset, count) {
  if (!(bitOffset & 7) && !(count & 7)) { dst.set(src.subarray(s, s + count / 8), d + bitOffset / 8); return; }
  for (let i = 0; i < count; i++) {
    const bit = (src[s + (i >> 3)] >> (7 - (i & 7))) & 1;
    const j = bitOffset + i;
    if (bit) dst[d + (j >> 3)] |= 0x80 >> (j & 7);
  }
}

function toRgba(page, store, rowBytes, bits, little) {
  const { width, height, samplesPerPixel: spp, planar } = page;
  const photometric = page.photometric;
  const max = (1 << bits) - 1;
  const out = new Uint8ClampedArray(width * height * 4);
  const sample = (plane, y, i) => {
    const row = store[plane];
    const o = y * rowBytes;
    if (bits === 8) return row[o + i];
    if (bits === 16) return little ? row[o + 2 * i] | (row[o + 2 * i + 1] << 8) : (row[o + 2 * i] << 8) | row[o + 2 * i + 1];
    const bit = i * bits;
    return (row[o + (bit >> 3)] >> (8 - bits - (bit & 7))) & max;
  };
  const get = (x, y, s) => (planar === 2 ? sample(s, y, x) : sample(0, y, x * spp + s));
  const to8 = v => (bits === 8 ? v : Math.round((v * 255) / max));
  const alphaIndex = page.extraSamples.length ? spp - page.extraSamples.length : -1;
  const associated = page.extraSamples[0] === 1;
  const map = page.colorMap;
  if (photometric === 3 && (!map || map.length < 3 * (max + 1))) throw fail('decode-failed', 'a palette TIFF without its palette');
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r, g, b;
      if (photometric === 0 || photometric === 1) {
        let v = to8(get(x, y, 0));
        if (photometric === 0) v = 255 - v;
        r = g = b = v;
      } else if (photometric === 2) {
        r = to8(get(x, y, 0)); g = to8(get(x, y, 1)); b = to8(get(x, y, 2));
      } else if (photometric === 3) {
        const i = get(x, y, 0), n = max + 1;
        r = map[i] >> 8; g = map[n + i] >> 8; b = map[2 * n + i] >> 8;
      } else if (photometric === 5) {
        const c = to8(get(x, y, 0)), m = to8(get(x, y, 1)), yy = to8(get(x, y, 2)), k = spp > 3 ? to8(get(x, y, 3)) : 0;
        r = Math.round(((255 - c) * (255 - k)) / 255); g = Math.round(((255 - m) * (255 - k)) / 255); b = Math.round(((255 - yy) * (255 - k)) / 255);
      } else throw fail('unsupported-format', 'unsupported TIFF colour model');
      if (alphaIndex >= 0 && alphaIndex < spp) {
        const a = to8(get(x, y, alphaIndex)) / 255;
        const over = v => Math.round(associated ? v + 255 * (1 - a) : v * a + 255 * (1 - a));
        r = over(r); g = over(g); b = over(b);
      }
      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}

/** Apply the TIFF orientation tag (1 to 8) so the result is upright. */
export function orient(img, orientation) {
  if (!orientation || orientation === 1 || orientation > 8) return img;
  const { width: w, height: h, data } = img;
  const swap = orientation >= 5;
  const W = swap ? h : w, H = swap ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sx, sy;
      switch (orientation) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        case 8: sx = w - 1 - y; sy = x; break;
        default: sx = x; sy = y;
      }
      const s = (sy * w + sx) * 4, d = (y * W + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { width: W, height: H, data: out };
}
