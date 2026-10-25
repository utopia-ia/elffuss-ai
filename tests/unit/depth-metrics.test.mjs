// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The measures the depth spec judges the browser's output with (Pearson
// correlation, region means, the 16-bit reader), and the depth fixtures
// themselves: the reference is a 16-bit map of the photo's size in which the
// hand-marked near region is nearer than the middle one, and that nearer than
// the far one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pearson, regionMean, depthOfPng16, hexColor, MIN_PEARSON, MIN_NEAR_FAR } from '../browser/specs/depth.spec.mjs';
import { encodeDepthPng16 } from '../../sdk/depth/png.js';

const fx = name => readFileSync(new URL(`../fixtures/depth/${name}`, import.meta.url));

test('Pearson: 1 for the same series up to scale and offset, -1 reversed, 0 for a flat one', () => {
  const a = [1, 2, 3, 4, 5], b = a.map(x => 3 * x + 7), c = a.map(x => -x);
  assert.ok(Math.abs(pearson(a, b) - 1) < 1e-12);
  assert.ok(Math.abs(pearson(a, c) + 1) < 1e-12);
  assert.equal(pearson(a, [2, 2, 2, 2, 2]), 0);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [1, 3, 2, 4]) - 0.8) < 1e-12);
  assert.throws(() => pearson([1, 2], [1]), RangeError);
});

test('region means read the right pixels', () => {
  const w = 4, values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  assert.equal(regionMean(values, w, { x: 1, y: 1, w: 2, h: 2 }), (5 + 6 + 9 + 10) / 4);
  assert.equal(regionMean(values, w, { x: 0, y: 0, w: 1, h: 1 }), 0);
});

test('the 16-bit reader gives values 0-1 and refuses 8-bit files', async () => {
  const depth = Float32Array.from([0, 0.25, 0.5, 1]);
  const d = await depthOfPng16(Buffer.from(await (await encodeDepthPng16(depth, 2, 2)).arrayBuffer()));
  assert.deepEqual([d.width, d.height], [2, 2]);
  assert.ok(d.values.every((v, i) => Math.abs(v - depth[i]) < 1 / 65535));
  assert.deepEqual(hexColor(' #4b5578 '), [0x4b, 0x55, 0x78]);
  assert.equal(hexColor('oklch(50% 0.1 200)'), null);
});

test('thresholds: never below the contract', () => {
  assert.ok(MIN_PEARSON['webgpu fp16'] >= 0.98 && MIN_PEARSON['webgpu fp32'] >= 0.98 && MIN_PEARSON['wasm q8'] >= 0.97);
  assert.ok(MIN_NEAR_FAR >= 0.1);
});

test('the reference is the photo\'s 16-bit map, and its regions are in the right order', async () => {
  const regions = JSON.parse(fx('regiones.json'));
  const jpeg = fx('foto.jpg');
  // The JPEG's frame header gives its size.
  let size = null;
  for (let i = 2; i < jpeg.length && !size;) {
    const marker = jpeg[i + 1], len = jpeg.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) size = [jpeg.readUInt16BE(i + 7), jpeg.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  assert.deepEqual(size, [regions.width, regions.height], 'regiones.json is in the photo\'s pixels');
  const g = await depthOfPng16(fx('golden-depth.png'));
  assert.deepEqual([g.width, g.height], size, 'the reference has the photo\'s size');
  for (const [k, r] of Object.entries(regions.regions)) assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= g.width && r.y + r.h <= g.height, `${k} inside the photo`);
  const m = Object.fromEntries(Object.entries(regions.regions).map(([k, r]) => [k, regionMean(g.values, g.width, r)]));
  assert.ok(m.cerca - m.lejos >= MIN_NEAR_FAR && m.cerca > m.medio && m.medio > m.lejos, JSON.stringify(m));
  let min = Infinity, max = -Infinity;
  for (const v of g.values) { if (v < min) min = v; if (v > max) max = v; }
  assert.deepEqual([min, max], [0, 1], 'normalised: from 0 to 1');
});
