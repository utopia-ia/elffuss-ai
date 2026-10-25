// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Detection around the DB detector, on synthetic probability maps: the input
// size, the normalised BGR tensor, connected regions (diagonals included),
// convex hull and minimum-area rectangle, the corner order, the mean
// probability inside a box, the expansion, the box threshold, the candidate
// limit and the scaling back to the image.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detInputSize, detTensor, regions, convexHull, minAreaRect, miniBoxOrder, boxScore, rowSpan, unclipRect, orderClockwise, dbPostprocess, filterBoxes } from '../../sdk/ocr/det.js';

const CFG = { limitSideLen: 736, maxSideLimit: 4000, multiple: 32 };
const POST = { thresh: 0.2, boxThresh: 0.45, maxCandidates: 3000, unclipRatio: 1.4, minSize: 3 };
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('input size: shortest side up to 736, longest under 4000, multiples of 32', () => {
  assert.deepEqual(detInputSize(1600, 1000, CFG), { width: 1600, height: 992 });
  assert.deepEqual(detInputSize(400, 200, CFG), { width: 1472, height: 736 });
  assert.deepEqual(detInputSize(8000, 6000, CFG), { width: 4000, height: 3008 });
  assert.deepEqual(detInputSize(3000, 200, CFG), { width: 4000, height: 256 });
  assert.deepEqual(detInputSize(10, 10, CFG), { width: 736, height: 736 });
  for (const [w, h] of [[1, 1], [123, 4567], [5000, 37]]) {
    const s = detInputSize(w, h, CFG);
    assert.ok(s.width % 32 === 0 && s.height % 32 === 0 && s.width >= 32 && s.height >= 32 && Math.max(s.width, s.height) <= 4000 + 16, `${w}×${h} → ${s.width}×${s.height}`);
  }
});

test('tensor: planar B, G, R normalised per channel; same size copies the pixels', () => {
  const img = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 128, 255, 255]) };
  const norm = { mean: [0.1, 0.2, 0.3], std: [0.5, 0.25, 0.125], scale: 1 / 255, bgr: true };
  const t = detTensor(img, 2, 1, norm);
  const v = (px, c) => (px / 255 - norm.mean[c]) / norm.std[c];
  // Channel 0 is blue, 1 green, 2 red.
  assert.ok([v(0, 0), v(255, 0)].every((x, i) => close(t[i], x)));
  assert.ok([v(0, 1), v(128, 1)].every((x, i) => close(t[2 + i], x)));
  assert.ok([v(255, 2), v(0, 2)].every((x, i) => close(t[4 + i], x)));
  const rgb = detTensor(img, 2, 1, { ...norm, bgr: false });
  assert.ok(close(rgb[0], v(255, 0)));
});

test('tensor: bilinear resampling with pixel centres aligned', () => {
  const img = { width: 2, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 200, 200, 200, 255]) };
  const t = detTensor(img, 4, 1, { mean: [0, 0, 0], std: [1, 1, 1], scale: 1, bgr: false });
  assert.deepEqual([...t.subarray(0, 4)], [0, 50, 150, 200]);
});

function mapWith(width, height, rects, value = 0.9) {
  const m = new Float32Array(width * height);
  for (const [x0, y0, x1, y1, v = value] of rects) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * width + x] = v;
  return m;
}

test('regions: 8-connected, diagonals join, separate blobs stay apart, raster order', () => {
  const m = mapWith(10, 6, [[0, 0, 1, 1], [2, 2, 3, 3], [7, 0, 9, 1], [6, 4, 9, 5]]);
  const r = regions(m, 10, 6, 0.2);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map(x => [x.xmin, x.ymin, x.xmax, x.ymax]), [[0, 0, 3, 3], [7, 0, 9, 1], [6, 4, 9, 5]]);
  assert.equal(regions(mapWith(10, 6, [[0, 0, 9, 5, 0.1]]), 10, 6, 0.2).length, 0, 'nothing above the threshold');
  // A U shape is one region even though its arms meet only at the bottom.
  const u = mapWith(7, 5, [[0, 0, 0, 4], [6, 0, 6, 4], [0, 4, 6, 4]]);
  assert.equal(regions(u, 7, 5, 0.2).length, 1);
});

test('hull and minimum-area rectangle, upright and turned', () => {
  assert.deepEqual(convexHull([0, 0, 4, 0, 4, 2, 0, 2, 2, 1, 2, 0]), [[0, 0], [4, 0], [4, 2], [0, 2]]);
  const r = minAreaRect([[0, 0], [10, 0], [10, 4], [0, 4]]);
  assert.ok(close(r.width * r.height, 40));
  assert.ok(close(Math.min(r.width, r.height), 4));
  // A 10 × 2 rectangle turned 30 degrees.
  const a = Math.PI / 6, c = Math.cos(a), s = Math.sin(a);
  const pts = [[0, 0], [10, 0], [10, 2], [0, 2]].map(([x, y]) => [x * c - y * s + 20, x * s + y * c + 5]);
  const rr = minAreaRect(convexHull(pts.flat()));
  assert.ok(close(Math.max(rr.width, rr.height), 10, 1e-9) && close(Math.min(rr.width, rr.height), 2, 1e-9));
  const one = minAreaRect([[3, 3]]);
  assert.deepEqual([one.width, one.height], [0, 0]);
});

test('corner order as PaddleOCR: top-left, top-right, bottom-right, bottom-left', () => {
  assert.deepEqual(miniBoxOrder([[10, 4], [0, 0], [0, 4], [10, 0]]), [[0, 0], [10, 0], [10, 4], [0, 4]]);
  assert.deepEqual(orderClockwise([[10, 4], [0, 0], [0, 4], [10, 0]]), [[0, 0], [10, 0], [10, 4], [0, 4]]);
  // Slightly turned: still clockwise from the top-left.
  assert.deepEqual(orderClockwise([[1, 10], [100, 12], [0, 0], [99, 2]]), [[0, 0], [99, 2], [100, 12], [1, 10]]);
});

test('mean probability inside a box, by pixel centres', () => {
  const m = mapWith(10, 10, [[2, 2, 5, 5, 1]]);
  assert.ok(close(boxScore(m, 10, 10, [[2, 2], [5, 2], [5, 5], [2, 5]]), 1));
  assert.ok(close(boxScore(m, 10, 10, [[0, 0], [9, 0], [9, 9], [0, 9]]), 16 / 100));
  assert.deepEqual(rowSpan([[0, 0], [4, 0], [4, 4], [0, 4]], 2), [0, 4]);
  assert.equal(rowSpan([[0, 0], [4, 0], [4, 4], [0, 4]], 5), null);
});

test('expansion by area × ratio / perimeter on every side', () => {
  const r = { corners: [[10, 10], [110, 10], [110, 30], [10, 30]], width: 100, height: 20 };
  const g = unclipRect(r, 1.5);
  const d = (100 * 20 * 1.5) / (2 * 120);
  assert.ok(close(g.width, 100 + 2 * d) && close(g.height, 20 + 2 * d));
  assert.ok(close(g.corners[0][0], 10 - d) && close(g.corners[0][1], 10 - d));
  assert.ok(close(g.corners[2][0], 110 + d) && close(g.corners[2][1], 30 + d));
});

test('post-processing: two text regions become two boxes in image pixels', () => {
  // Map of 200 × 100 for an image of 400 × 200: boxes are scaled by 2.
  const m = mapWith(200, 100, [[20, 20, 119, 29], [20, 60, 79, 69]]);
  const boxes = dbPostprocess(m, 200, 100, POST, 400, 200);
  assert.equal(boxes.length, 2);
  const [a, b] = boxes;
  assert.ok(close(a.score, 0.9, 1e-6));
  const d = (99 * 9 * 1.4) / (2 * (99 + 9));
  assert.deepEqual(a.points, [[20 - d, 20 - d], [119 + d, 20 - d], [119 + d, 29 + d], [20 - d, 29 + d]].map(([x, y]) => [Math.round(x * 2), Math.round(y * 2)]));
  assert.ok(b.points[0][1] > a.points[2][1], 'the second box is below the first');
});

test('post-processing drops thin regions, weak boxes, and keeps at most maxCandidates', () => {
  const thin = mapWith(100, 50, [[10, 10, 90, 11]]);
  assert.equal(dbPostprocess(thin, 100, 50, POST, 100, 50).length, 0, 'a line two pixels high');
  // Above the binarisation threshold but below the box threshold.
  const weak = mapWith(100, 50, [[10, 10, 90, 30, 0.3]]);
  assert.equal(dbPostprocess(weak, 100, 50, POST, 100, 50).length, 0);
  const many = mapWith(100, 50, [[5, 5, 20, 15], [30, 5, 45, 15], [55, 5, 70, 15]]);
  assert.equal(dbPostprocess(many, 100, 50, { ...POST, maxCandidates: 2 }, 100, 50).length, 2);
  const clipped = dbPostprocess(mapWith(50, 50, [[0, 0, 49, 10]]), 50, 50, POST, 50, 50);
  for (const [x, y] of clipped[0].points) assert.ok(x >= 0 && x <= 50 && y >= 0 && y <= 50);
});

test('filtering before the crop: clockwise, clipped, more than 3 pixels each way', () => {
  const out = filterBoxes([
    { points: [[-5, 2], [60, 2], [60, 20], [-5, 20]], score: 0.9 },
    { points: [[0, 0], [3, 0], [3, 30], [0, 30]], score: 0.9 },
  ], 50, 40);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].points, [[0, 2], [49, 2], [49, 20], [0, 20]]);
});
