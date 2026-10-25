// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The image maths of the remove-bg task, without a browser: PIL's bilinear
// resampling (checked against values Pillow gives), the model input read from
// the processor config, the mask back at the image's size, the alpha on the
// pixels, and the module's public shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resampleWeights, resamplePlane, inputSpec, toModelInput, maskToAlpha, applyAlpha, coverage, sideLimit, MAX_SIDE } from '../../sdk/remove-bg/mask.js';

const close = (got, want, eps, msg) => {
  assert.equal(got.length, want.length, `${msg}: length`);
  for (let i = 0; i < want.length; i++) assert.ok(Math.abs(got[i] - want[i]) <= eps, `${msg}[${i}]: ${got[i]} vs ${want[i]}`);
};

test('resampling weights: every row sums to 1, the same size is the identity', () => {
  for (const [a, b] of [[8, 3], [3, 8], [1024, 1024], [4000, 1024], [683, 1024], [1, 7], [7, 1]]) {
    const w = resampleWeights(a, b);
    for (let o = 0; o < b; o++) {
      let s = 0;
      for (let i = 0; i < w.count[o]; i++) s += w.weights[o * w.ksize + i];
      assert.ok(Math.abs(s - 1) < 1e-5, `${a}→${b} row ${o} sums to ${s}`);
      assert.ok(w.start[o] >= 0 && w.start[o] + w.count[o] <= a, `${a}→${b} row ${o} stays inside`);
    }
  }
  const id = resampleWeights(5, 5);
  for (let o = 0; o < 5; o++) {
    const taps = [...id.weights.subarray(o * id.ksize, o * id.ksize + id.count[o])];
    const at = taps.findIndex(x => x > 0.999);
    assert.equal(id.start[o] + at, o, 'pixel o comes from pixel o');
  }
  assert.throws(() => resampleWeights(0, 4), RangeError);
  assert.throws(() => resampleWeights(4, 1.5), RangeError);
});

test('resampling matches Pillow (Image.resize with BILINEAR on a float image)', () => {
  // Values printed by Pillow 10.4 for 1-pixel-high float images.
  close(resamplePlane([0, 10, 20, 30, 40, 50, 60, 70], 8, 1, 3, 1), [11.05263, 35.0, 58.94737], 1e-4, '8→3');
  close(resamplePlane([0, 30, 60], 3, 1, 8, 1), [0, 1.875, 13.125, 24.375, 35.625, 46.875, 58.125, 60], 1e-4, '3→8');
  close(resamplePlane([0, 100, 0, 100, 0], 5, 1, 2, 1), [45.45454, 45.45454], 1e-4, '5→2');
  close(resamplePlane([0, 1, 4, 9, 16, 25, 36], 7, 1, 3, 1), [1.28571, 9.94118, 27.0], 1e-4, '7→3');
  // Separable: the vertical pass is the same filter.
  close(resamplePlane([0, 10, 20, 30, 40, 50, 60, 70], 1, 8, 1, 3), [11.05263, 35.0, 58.94737], 1e-4, 'vertical 8→3');
  assert.throws(() => resamplePlane([1, 2, 3], 2, 2, 1, 1), RangeError);
});

test('a constant plane stays constant at any size; shrinking averages instead of sampling', () => {
  for (const [w, h, ow, oh] of [[3, 2, 9, 7], [64, 48, 5, 5], [17, 1, 1, 1]]) {
    const out = resamplePlane(new Float32Array(w * h).fill(0.25), w, h, ow, oh);
    for (const v of out) assert.ok(Math.abs(v - 0.25) < 1e-6);
  }
  // A one-pixel checkerboard shrunk 8 times is grey everywhere, not one of its two values.
  const w = 64, src = new Float32Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) src[y * w + x] = (x + y) % 2;
  for (const v of resamplePlane(src, w, w, 8, 8)) assert.ok(Math.abs(v - 0.5) < 0.05, `got ${v}`);
});

test('the input spec comes from the processor config, and a model without a fixed size is refused', () => {
  const ben2 = { size: { height: 1024, width: 1024 }, image_mean: [0.485, 0.456, 0.406], image_std: [0.229, 0.224, 0.225], rescale_factor: 1 / 255, do_rescale: true, do_normalize: true, do_resize: true };
  assert.deepEqual(inputSpec(ben2), { width: 1024, height: 1024, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], rescale: 1 / 255 });
  assert.deepEqual(inputSpec({ size: 512, image_mean: 0.5, image_std: 0.5 }), { width: 512, height: 512, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], rescale: 1 / 255 });
  assert.deepEqual(inputSpec({ ...ben2, do_normalize: false, do_rescale: false }), { width: 1024, height: 1024, mean: [0, 0, 0], std: [1, 1, 1], rescale: 1 });
  assert.throws(() => inputSpec({ ...ben2, size: { shortest_edge: 1024 } }), { code: 'model-mismatch' });
  assert.throws(() => inputSpec({ ...ben2, do_resize: false }), { code: 'model-mismatch' });
  assert.throws(() => inputSpec({ ...ben2, image_std: [0.2, 0, 0.2] }), { code: 'model-mismatch' });
  assert.throws(() => inputSpec({ ...ben2, image_mean: [0.5, 0.5] }), { code: 'model-mismatch' });
  assert.throws(() => inputSpec(null), { code: 'model-mismatch' });
});

test('the model input is planar RGB, resized and normalised; the alpha of the image is not read', () => {
  const spec = { width: 4, height: 2, mean: [0.5, 0.25, 0], std: [0.5, 0.25, 1], rescale: 1 / 255 };
  // 2×1 image: left pixel red, right pixel blue, the right one half transparent.
  const img = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 128]) };
  const x = toModelInput(img, spec);
  assert.equal(x.length, 3 * 4 * 2);
  const plane = c => [...x.subarray(c * 8, c * 8 + 4)];
  // Red channel along a row: red, red, then towards blue (bilinear 2→4: 1, 0.75, 0.25, 0).
  close(plane(0), [1, 0.5, -0.5, -1], 1e-5, 'R normalised');
  close(plane(1), [-1, -1, -1, -1], 1e-5, 'G normalised');
  close(plane(2), [0, 0.25, 0.75, 1], 1e-5, 'B normalised');
  close([...x.subarray(4, 8)], plane(0), 1e-6, 'the second row repeats the first');
  assert.throws(() => toModelInput({ width: 2, height: 2, data: new Uint8Array(12) }, spec), RangeError);
});

test('the mask comes back at the image size; logits get a sigmoid; broken masks are refused', () => {
  // 2×2 mask, left column kept, enlarged to 4×2: alpha falls off across the middle.
  const a = maskToAlpha(new Float32Array([1, 0, 1, 0]), 2, 2, 4, 2);
  assert.deepEqual([...a], [255, 191, 64, 0, 255, 191, 64, 0]);
  // Values already in 0-1 are used as they are.
  assert.deepEqual([...maskToAlpha(new Float32Array([0.5, 0.5, 0.5, 0.5]), 2, 2, 2, 2)], [128, 128, 128, 128]);
  // Logits (outside 0-1) go through a sigmoid: 0 → 0.5, large → 1, very negative → 0.
  assert.deepEqual([...maskToAlpha(new Float32Array([0, 12, -12, 0]), 2, 2, 2, 2)], [128, 255, 0, 128]);
  assert.throws(() => maskToAlpha(new Float32Array([0, NaN, 1, 1]), 2, 2, 2, 2), { code: 'run-failed' });
  assert.throws(() => maskToAlpha(new Float32Array(3), 2, 2, 2, 2), { code: 'model-mismatch' });
  const big = maskToAlpha(new Float32Array(1024 * 1024).fill(1), 1024, 1024, 960, 640);
  assert.equal(big.length, 960 * 640);
  assert.ok(big.every(v => v === 255));
});

test('the alpha goes on the pixels, keeping the transparency the image already had', () => {
  const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 0]);
  const alpha = new Uint8Array([200, 255, 255]);
  applyAlpha(rgba, alpha);
  assert.deepEqual([...rgba], [10, 20, 30, 200, 40, 50, 60, 128, 70, 80, 90, 0], 'colours untouched, alpha = mask × own alpha');
  assert.deepEqual([...alpha], [200, 128, 0], 'the alpha returned is the one in the pixels');
  assert.throws(() => applyAlpha(new Uint8ClampedArray(8), new Uint8Array(3)), RangeError);
});

test('coverage and the side limit', () => {
  assert.equal(coverage(new Uint8Array([0, 127, 128, 255])), 0.5);
  assert.equal(coverage(new Uint8Array(0)), 0);
  assert.equal(coverage(new Uint8Array([10, 20]), 15), 0.5);
  assert.equal(MAX_SIDE, 8192);
  assert.equal(sideLimit(undefined), MAX_SIDE);
  assert.equal(sideLimit(2048), 2048);
  assert.equal(sideLimit(100000), MAX_SIDE, 'never above the limit');
  assert.equal(sideLimit(0), MAX_SIDE);
  assert.equal(sideLimit(1.5), MAX_SIDE);
  assert.equal(sideLimit('512'), 512);
});

test('the module: a Task with the remove-bg spec, its one-call form, its export and its Worker', async () => {
  const mod = await import('../../sdk/remove-bg/index.js');
  const { Task } = await import('../../sdk/core/task.js');
  assert.equal(typeof mod.RemoveBg, 'function');
  assert.ok(new mod.RemoveBg({ worker: false }) instanceof Task);
  assert.equal(typeof mod.removeBg, 'function');
  assert.equal(mod.MAX_SIDE, MAX_SIDE);
  const impl = await import('../../sdk/remove-bg/impl.js');
  assert.equal(impl.task, 'remove-bg');
  for (const f of ['load', 'run', 'dispose']) assert.equal(typeof impl[f], 'function', f);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./remove-bg'], './sdk/remove-bg/index.js');
  const worker = readFileSync(new URL('../../sdk/remove-bg/worker.js', import.meta.url), 'utf8').split('\n').filter(l => l && !l.startsWith('//'));
  assert.deepEqual(worker, ["import { serveTask } from '../core/worker-rpc.js';", "import * as impl from './impl.js';", 'serveTask(impl);']);
});

test('asking for WebGPU is refused before anything loads: the registry declares WebAssembly only', async () => {
  const { RemoveBg } = await import('../../sdk/remove-bg/index.js');
  const registry = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
  const store = { has: async () => true, get: async (u, { bytes }) => new Blob([new Uint8Array(bytes)]) };
  const runtime = { ortBundle: '/x.mjs', ortMjs: '/y.mjs', ortWasm: '/z.wasm', transformers: '/t.js' };
  const t = new RemoveBg({ worker: false, device: 'webgpu', registry, store, runtime });
  await assert.rejects(t.load(), { code: 'device-unsupported' }, 'the registry declares no WebGPU variant');
});
