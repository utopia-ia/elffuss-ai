// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The depth task's pure helpers: normalisation to 0-1, grey and colour pixels,
// and the 16-bit PNG, read back by our reader and, independently, by Node's
// zlib and CRC-32 with the PNG filters undone here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync, deflateSync, crc32 as zcrc32 } from 'node:zlib';
import { normalizeDepth, depthToGrey, rampColor, colorizeDepth, RAMP_STEPS } from '../../sdk/depth/maps.js';
import { encodeDepthPng16, decodePng, filterRow } from '../../sdk/depth/png.js';
import * as api from '../../sdk/depth/index.js';

test('normalisation: min becomes 0, max 1, order kept; flat and non-finite values are safe', () => {
  const { depth, min, max } = normalizeDepth([2, 4, 3, 6]);
  assert.deepEqual([...depth], [0, 0.5, 0.25, 1]);
  assert.deepEqual([min, max], [2, 6]);
  assert.deepEqual([...normalizeDepth(new Float32Array([5, 5, 5])).depth], [0, 0, 0], 'a flat map is all zeros');
  const odd = normalizeDepth([1, NaN, 3, Infinity, -Infinity]);
  assert.deepEqual([...odd.depth], [0, 0, 1, 0, 0], 'non-finite values become 0 and do not set the range');
  assert.deepEqual([odd.min, odd.max], [1, 3]);
  assert.deepEqual([...normalizeDepth([]).depth], []);
});

test('grey: 0 black, 1 white, opaque, rounded', () => {
  assert.deepEqual([...depthToGrey([0, 1, 0.5, 2, -1])], [0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
});

test('ramp: ends are the first and last stops, midpoints interpolate', () => {
  const stops = [[0, 0, 0], [100, 200, 50], [200, 0, 250]];
  assert.deepEqual(rampColor(stops, 0), [0, 0, 0]);
  assert.deepEqual(rampColor(stops, 1), [200, 0, 250]);
  assert.deepEqual(rampColor(stops, 0.5), [100, 200, 50]);
  assert.deepEqual(rampColor(stops, 0.25), [50, 100, 25]);
  assert.deepEqual(rampColor(stops, 5), [200, 0, 250], 'clamped');
  assert.throws(() => rampColor([[1, 2, 3]], 0.5), TypeError);
});

test('colour pixels follow the ramp, far first, opaque', () => {
  const stops = [[10, 20, 30], [250, 240, 230]];
  const px = colorizeDepth(new Float32Array([0, 1, 0.5, NaN]), stops);
  assert.deepEqual([...px.subarray(0, 4)], [10, 20, 30, 255], 'farthest');
  assert.deepEqual([...px.subarray(4, 8)], [250, 240, 230, 255], 'nearest');
  const mid = rampColor(stops, Math.round(0.5 * (RAMP_STEPS - 1)) / (RAMP_STEPS - 1));
  assert.deepEqual([...px.subarray(8, 11)], mid, 'the middle, within one step of the table');
  assert.deepEqual([...px.subarray(12, 16)], [10, 20, 30, 255], 'NaN is far');
});

/** Undo the PNG filters with plain code, independent of the module under test. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const t = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y ? out[(y - 1) * stride + i] : 0;
      const c = y && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0;
      let p = 0;
      if (t === 1) p = a; else if (t === 2) p = b; else if (t === 3) p = Math.floor((a + b) / 2);
      else if (t === 4) { const q = a + b - c; const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + i] = (x + p) & 0xff;
    }
  }
  return out;
}

function chunks(buf) {
  const out = [];
  for (let pos = 8; pos < buf.length;) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    out.push({ type, data: buf.subarray(pos + 8, pos + 8 + len), crc: buf.readUInt32BE(pos + 8 + len), crcOk: zcrc32(buf.subarray(pos + 4, pos + 8 + len)) === buf.readUInt32BE(pos + 8 + len) });
    pos += 12 + len;
  }
  return out;
}

test('16-bit PNG: valid chunks, 16-bit grey header, values back exactly (checked with zlib too)', async () => {
  const w = 37, h = 23;
  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) depth[y * w + x] = ((x * 7 + y * 13) % 101) / 100;
  depth[0] = 0; depth[1] = 1;
  const blob = await encodeDepthPng16(depth, w, h);
  assert.equal(blob.type, 'image/png');
  const buf = Buffer.from(await blob.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const cs = chunks(buf);
  assert.deepEqual(cs.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.ok(cs.every(c => c.crcOk), 'every CRC matches zlib');
  const ihdr = cs[0].data;
  assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ...ihdr.subarray(8, 13)], [w, h, 16, 0, 0, 0, 0]);
  const raw = unfilter(inflateSync(cs[1].data), w, h, 2);
  const want = Array.from(depth, v => Math.round(v * 65535));
  const got = Array.from({ length: w * h }, (_, i) => raw.readUInt16BE(2 * i));
  assert.deepEqual(got, want, 'zlib and plain unfiltering give the exact values');
  const back = await decodePng(buf);
  assert.deepEqual([back.width, back.height, back.bitDepth, back.channels], [w, h, 16, 1]);
  assert.ok(back.data instanceof Uint16Array);
  assert.deepEqual([...back.data], want, 'our reader agrees');
  await assert.rejects(encodeDepthPng16(depth, w + 1, h), RangeError);
});

test('the filter heuristic picks a filter that makes a smooth ramp cheaper', () => {
  const row = Uint8Array.from({ length: 64 }, (_, i) => i * 3);
  const f = filterRow(row, null, 1);
  assert.equal(f[0], 1, 'Sub for a ramp along the row');
  const f2 = filterRow(row, row, 1);
  assert.equal(f2[0], 2, 'Up when the row repeats the one above');
});

test('the reader takes 8-bit RGBA and grey PNGs with every filter, and refuses broken ones', async () => {
  const w = 5, h = 5, bpp = 4;
  const pixels = Buffer.alloc(w * h * bpp);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) & 0xff;
  // Filter row y with type y (0..4), by hand.
  const raw = Buffer.alloc(h * (w * bpp + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * bpp + 1)] = y;
    for (let i = 0; i < w * bpp; i++) {
      const cur = pixels[y * w * bpp + i];
      const a = i >= bpp ? pixels[y * w * bpp + i - bpp] : 0;
      const b = y ? pixels[(y - 1) * w * bpp + i] : 0;
      const c = y && i >= bpp ? pixels[(y - 1) * w * bpp + i - bpp] : 0;
      let p = 0;
      if (y === 1) p = a; else if (y === 2) p = b; else if (y === 3) p = Math.floor((a + b) / 2);
      else if (y === 4) { const q = a + b - c; const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      raw[y * (w * bpp + 1) + 1 + i] = (cur - p) & 0xff;
    }
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zcrc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0x')), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const back = await decodePng(new Uint8Array(png));
  assert.deepEqual([back.width, back.height, back.bitDepth, back.channels], [w, h, 8, 4]);
  assert.deepEqual([...back.data], [...pixels]);
  const bad = Buffer.from(png); bad[bad.length - 20] ^= 1;
  await assert.rejects(decodePng(bad), /CRC/);
  await assert.rejects(decodePng(new Uint8Array([1, 2, 3])), /not a PNG/);
  const pal = Buffer.from(ihdr); pal[9] = 3;
  const palPng = Buffer.concat([png.subarray(0, 8), chunk('IHDR', pal), chunk('IEND', Buffer.alloc(0))]);
  await assert.rejects(decodePng(palPng), /not read here/);
});

test('the public module exports the class, the one-call form and the helpers', () => {
  for (const name of ['Depth', 'depth', 'normalizeDepth', 'depthToGrey', 'rampColor', 'colorizeDepth', 'encodeDepthPng16', 'decodePng']) assert.equal(typeof api[name], 'function', name);
  assert.equal(api.RAMP_STEPS, RAMP_STEPS);
});
