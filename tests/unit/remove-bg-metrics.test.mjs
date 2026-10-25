// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The measuring tools of the cutout browser spec, checked on their own so that
// its pass or fail means something: the PNG reader (every row filter) and
// writer, the polygon filler with holes, IoU and mean error, the JPEG size, and
// the shape of the cutout fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { decodePng, encodeGreyPng, alphaOf, greyOf, rasterize, iou, meanAbsError, jpegSize, withOrientation, THRESHOLDS } from '../browser/specs/cutout.spec.mjs';

const FIX = new URL('../fixtures/cutout/', import.meta.url);

/** A PNG with each row filtered in turn with filters 0 to 4 (what encoders such as Chrome's use). */
function filteredPng(width, height, channels, data) {
  const type = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  const stride = width * channels;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const f = y % 5, row = Buffer.alloc(stride + 1);
    row[0] = f;
    for (let x = 0; x < stride; x++) {
      const v = data[y * stride + x];
      const a = x >= channels ? data[y * stride + x - channels] : 0;
      const b = y ? data[(y - 1) * stride + x] : 0;
      const c = y && x >= channels ? data[(y - 1) * stride + x - channels] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      row[x + 1] = (v - pred) & 255;
    }
    rows.push(row);
  }
  const chunk = (kind, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = type;
  const idat = deflateSync(Buffer.concat(rows));
  // Split the image data in two chunks: readers must join them.
  const half = idat.length >> 1;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat.subarray(0, half)), chunk('IDAT', idat.subarray(half)), chunk('IEND', Buffer.alloc(0))]);
}

const noise = (n, seed) => {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; out[i] = s >>> 24; }
  return out;
};

test('the PNG reader undoes every row filter, for grey, grey and alpha, RGB and RGBA', () => {
  for (const channels of [1, 2, 3, 4]) {
    const w = 13, h = 11, data = noise(w * h * channels, channels);
    const png = decodePng(filteredPng(w, h, channels, data));
    assert.equal(png.channels, channels);
    assert.deepEqual([png.width, png.height], [w, h]);
    assert.deepEqual([...png.data], [...data], `${channels} channels`);
  }
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
});

test('the grey PNG writer reads back, and the alpha and grey views pick the right channel', () => {
  for (const [w, h] of [[1, 1], [7, 3], [64, 5]]) {
    const data = noise(w * h, w);
    const png = decodePng(encodeGreyPng(w, h, data));
    assert.deepEqual([png.width, png.height, png.channels, png.colorType], [w, h, 1, 0]);
    assert.deepEqual([...greyOf(png)], [...data]);
    assert.ok(alphaOf(png).every(v => v === 255), 'a grey PNG is opaque');
  }
  const rgba = decodePng(filteredPng(2, 1, 4, new Uint8Array([1, 2, 3, 40, 5, 6, 7, 80])));
  assert.deepEqual([...alphaOf(rgba)], [40, 80]);
  assert.deepEqual([...greyOf(rgba)], [1, 5]);
  const ga = decodePng(filteredPng(2, 1, 2, new Uint8Array([9, 90, 8, 80])));
  assert.deepEqual([...alphaOf(ga)], [90, 80]);
});

test('polygons fill at pixel centres, with the even-odd rule for holes', () => {
  const sq = rasterize([[[1, 1], [5, 1], [5, 4], [1, 4]]], 8, 6);
  assert.equal(sq.filter(Boolean).length, 4 * 3, 'a 4×3 square covers 12 pixels');
  assert.equal(sq[1 * 8 + 1], 255);
  assert.equal(sq[0 * 8 + 1], 0);
  assert.equal(sq[1 * 8 + 5], 0, 'the right edge is outside');
  const ring = rasterize([[[0, 0], [8, 0], [8, 8], [0, 8]], [[2, 2], [6, 2], [6, 6], [2, 6]]], 8, 8);
  assert.equal(ring.filter(Boolean).length, 64 - 16, 'the inner square is a hole');
  assert.equal(ring[4 * 8 + 4], 0);
  const tri = rasterize([[[0, 0], [10, 0], [0, 10]]], 10, 10);
  assert.equal(tri.filter(Boolean).length, 45, 'a right triangle of side 10 covers 45 pixel centres');
});

test('IoU and mean error', () => {
  const a = new Uint8Array([255, 255, 0, 0]), b = new Uint8Array([255, 0, 255, 0]);
  assert.equal(iou(a, a), 1);
  assert.equal(iou(a, b), 1 / 3);
  assert.equal(iou(new Uint8Array(4), new Uint8Array(4)), 1, 'two empty masks agree');
  assert.equal(iou(new Uint8Array([127]), new Uint8Array([128])), 0, 'the threshold is 128');
  assert.equal(meanAbsError(new Uint8Array([0, 255]), new Uint8Array([255, 255])), 0.5);
  assert.equal(meanAbsError(a, a), 0);
  assert.throws(() => iou(a, new Uint8Array(3)));
  assert.deepEqual(THRESHOLDS, { polygonIoU: 0.85, referenceIoU: 0.98, referenceMeanError: 0.01, colourError: 1 });
});

test('a JPEG gets an Exif orientation without touching its image data', () => {
  const jpg = readFileSync(new URL('foto.jpg', FIX));
  const turned = withOrientation(jpg, 6);
  assert.deepEqual(jpegSize(turned), jpegSize(jpg), 'the stored size is the same; only the display turns');
  assert.deepEqual([...turned.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe1], 'an APP1 segment right after the start');
  const len = (turned[4] << 8) | turned[5];
  const app1 = turned.subarray(6, 4 + len);
  assert.equal(app1.subarray(0, 6).toString('latin1'), 'Exif\0\0');
  const tiff = app1.subarray(6);
  assert.equal(tiff.readUInt16LE(8 + 2), 0x0112, 'the entry is the orientation');
  assert.equal(tiff.readUInt16LE(8 + 2 + 8), 6);
  assert.ok(turned.subarray(4 + len).equals(jpg.subarray(2)), 'the rest is the original');
});

test('the cutout fixtures: a 960×640 JPEG, a polygon in its pixels, a grey reference of its size', () => {
  const jpg = readFileSync(new URL('foto.jpg', FIX));
  assert.deepEqual(jpegSize(jpg), { width: 960, height: 640 });
  assert.throws(() => jpegSize(Buffer.alloc(16).fill(0, 2).fill(0xff, 0, 1)), /marker/);
  assert.throws(() => jpegSize(Buffer.from([0xff, 0xd8])), /no JPEG frame header/);
  const m = JSON.parse(readFileSync(new URL('mascara.json', FIX), 'utf8'));
  assert.deepEqual([m.width, m.height, m.rule, m.image], [960, 640, 'evenodd', 'foto.jpg']);
  assert.equal(m.polygons.length, 2, 'the outline and the hole between the legs');
  for (const ring of m.polygons) {
    assert.ok(ring.length >= 3);
    for (const [x, y] of ring) assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x <= 960 && y >= 0 && y <= 640, `${x},${y}`);
  }
  const share = rasterize(m.polygons, 960, 640).filter(Boolean).length / (960 * 640);
  assert.ok(share > 0.15 && share < 0.25, `the dog covers about a fifth of the photo (${share.toFixed(3)})`);
  const golden = decodePng(readFileSync(new URL('golden-alpha.png', FIX)));
  assert.deepEqual([golden.width, golden.height, golden.channels], [960, 640, 1]);
  // The reference and the hand polygon agree (this is what the browser spec asks of every run).
  assert.ok(iou(greyOf(golden), rasterize(m.polygons, 960, 640)) >= THRESHOLDS.polygonIoU);
  const sha = createHash('sha256').update(readFileSync(new URL('golden-alpha.png', FIX))).digest('hex');
  const sources = JSON.parse(readFileSync(new URL('../SOURCES.json', FIX), 'utf8'));
  assert.equal(sources.files.find(f => f.path === 'tests/fixtures/cutout/golden-alpha.png')?.sha256, sha);
});
