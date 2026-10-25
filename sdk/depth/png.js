// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A 16-bit greyscale PNG for depth maps, and a small PNG reader. Canvas only
// writes 8 bits per channel, which leaves 256 levels of depth; the 16-bit file
// keeps 65,536, enough for 3D tools and for comparing two maps. Both directions
// use the browser's CompressionStream and DecompressionStream (also in Node),
// so nothing else is needed.

import { crc32 } from '../core/zip.js';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });

async function through(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(ascii(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

// Filter one scanline (`prev` is the raw row above, or null) with each of the
// five PNG filters and keep the one whose bytes, read as signed, add up to the
// least (the usual heuristic). Returns the filter type byte and the row.
// Exported for the tests only.
export function filterRow(row, prev, bpp) {
  const n = row.length;
  let best = null, bestCost = Infinity;
  for (let type = 0; type <= 4; type++) {
    const out = new Uint8Array(n + 1);
    out[0] = type;
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
      const v = (row[i] - pred) & 0xff;
      out[i + 1] = v;
      cost += v < 128 ? v : 256 - v;
    }
    if (cost < bestCost) { best = out; bestCost = cost; }
  }
  return best;
}

/**
 * A 16-bit greyscale PNG of a depth map: 0 becomes 0 and 1 becomes 65535
 * (lighter is nearer, as in the 8-bit map).
 * @param {ArrayLike<number>} depth values 0-1, row by row
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Blob>} an `image/png` Blob
 */
export async function encodeDepthPng16(depth, width, height) {
  if (!(width > 0 && height > 0) || depth.length !== width * height) throw new RangeError('the depth map does not have width × height values');
  const stride = width * 2;
  const raw = new Uint8Array(height * (stride + 1));
  let prev = null;
  const row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round(Math.min(1, Math.max(0, depth[y * width + x] || 0)) * 65535);
      row[2 * x] = v >> 8;
      row[2 * x + 1] = v & 0xff;
    }
    raw.set(filterRow(row, prev, 2), y * (stride + 1));
    prev = row.slice();
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([16, 0, 0, 0, 0], 8); // 16 bits, greyscale, deflate, adaptive filters, no interlace
  const idat = await through(raw, new CompressionStream('deflate'));
  return new Blob([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}

/**
 * Read a PNG: greyscale, grey with alpha, RGB or RGBA, at 8 or 16 bits, not
 * interlaced. Checks the signature and every chunk's CRC.
 * @param {ArrayBuffer|Uint8Array|Blob} input
 * @returns {Promise<{ width: number, height: number, bitDepth: 8|16, channels: number, data: Uint8Array|Uint16Array }>}
 *   `data` holds `channels` samples per pixel, row by row
 */
export async function decodePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input instanceof Blob ? await input.arrayBuffer() : input);
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new TypeError('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, header = null;
  const idat = [];
  for (;;) {
    if (pos + 12 > bytes.length) throw new TypeError('PNG ends before IEND');
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (pos + 12 + len > bytes.length) throw new TypeError(`PNG chunk ${type} is cut`);
    if (crc32(bytes.subarray(pos + 4, pos + 8 + len)) !== view.getUint32(pos + 8 + len)) throw new TypeError(`PNG chunk ${type} has a bad CRC`);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      const h = new DataView(data.buffer, data.byteOffset, data.byteLength);
      header = { width: h.getUint32(0), height: h.getUint32(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!header) throw new TypeError('PNG without IHDR');
  const { width, height, bitDepth, colorType, interlace } = header;
  const channels = CHANNELS[colorType];
  if (!channels || (bitDepth !== 8 && bitDepth !== 16) || interlace !== 0) throw new TypeError(`PNG kind not read here (colour type ${colorType}, ${bitDepth} bits, interlace ${interlace})`);
  const joined = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
  idat.reduce((o, d) => { joined.set(d, o); return o + d.length; }, 0);
  const raw = await through(joined, new DecompressionStream('deflate'));
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new TypeError('PNG image data is short');
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? paeth(a, b, c) : -1;
      if (pred < 0) throw new TypeError(`PNG row ${y} has filter ${type}`);
      cur[i] = (src[i] + pred) & 0xff;
    }
  }
  if (bitDepth === 8) return { width, height, bitDepth, channels, data: pixels };
  const data = new Uint16Array(width * height * channels);
  for (let i = 0; i < data.length; i++) data[i] = (pixels[2 * i] << 8) | pixels[2 * i + 1];
  return { width, height, bitDepth, channels, data };
}
