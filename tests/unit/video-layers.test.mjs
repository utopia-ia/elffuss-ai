// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The pure parts of the video task: depth to layers, the inpainting crop and
// composite, the depth model's input, options and sizes, the soundtrack, and
// the half floats and grid of the renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDisparity, resizePlane, boxMean, guidedFilter, morph, components, cleanMask, pushPull, chooseSplit, planLayers, fillBehind, extendOutward, softAlpha, decontaminate, borderSamples } from '../../sdk/video/layers.js';
import { cropFor, modelInputs, composite, SIDE } from '../../sdk/video/inpaint.js';
import { depthSpec, depthInputSize, toDepthInput } from '../../sdk/video/depth.js';
import { normalizeOptions, outputSize, autoQuality, SECONDS } from '../../sdk/video/options.js';
import { fitSoundtrack, soundtrackOf } from '../../sdk/video/audio.js';
import { toHalf, gridMesh } from '../../sdk/video/render.js';

/** A scene: a near square (0.9) on a far ground with a gentle slope (0.1-0.3). */
function scene(w = 96, h = 64) {
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = x >= 30 && x < 60 && y >= 16 && y < 48 ? 0.9 : 0.1 + 0.2 * (y / h);
  return { d, w, h };
}

test('disparity is normalised by robust quantiles', () => {
  const raw = Float32Array.from({ length: 1000 }, (_, i) => i);
  raw[0] = -1e9; raw[999] = 1e9;
  const n = normalizeDisparity(raw);
  assert.equal(n[0], 0); assert.equal(n[999], 1);
  assert.ok(n[500] > 0.45 && n[500] < 0.55);
});

test('box mean and resize keep a flat plane flat; the guided filter keeps an edge', () => {
  const flat = new Float32Array(40 * 30).fill(0.4);
  assert.ok(boxMean(flat, 40, 30, 3).every(v => Math.abs(v - 0.4) < 1e-6));
  assert.ok(resizePlane(flat, 40, 30, 13, 7).every(v => Math.abs(v - 0.4) < 1e-6));
  const I = new Float32Array(40 * 30), p = new Float32Array(40 * 30);
  for (let i = 0; i < I.length; i++) { const x = i % 40; I[i] = x < 20 ? 0 : 1; p[i] = x < 20 ? 0.2 : 0.8; }
  const q = guidedFilter(I, p, 40, 30, 4, 1e-4);
  assert.ok(q[15 * 40 + 17] < 0.25 && q[15 * 40 + 22] > 0.75, 'the step stays sharp');
});

test('masks: dilation, erosion, parts and cleaning', () => {
  const m = new Uint8Array(20 * 20);
  m[10 * 20 + 10] = 1;
  assert.equal(morph(m, 20, 20, 2).reduce((s, v) => s + v, 0), 25);
  assert.equal(morph(morph(m, 20, 20, 2), 20, 20, -2).reduce((s, v) => s + v, 0), 1);
  m[2 * 20 + 2] = 1;
  assert.deepEqual(components(m, 20, 20).sizes, [1, 1]);
  const big = morph(m, 20, 20, 3);
  big[10 * 20 + 10] = 0; // a hole of one pixel
  const c = cleanMask(big, 20, 20, 4);
  assert.equal(c[10 * 20 + 10], 1, 'small holes filled');
});

test('push-pull fills from around and keeps what is known', () => {
  const w = 32, h = 32, v = new Float32Array(w * h), k = new Float32Array(w * h).fill(1);
  for (let i = 0; i < v.length; i++) v[i] = (i % w) / w;
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) { k[y * w + x] = 0; v[y * w + x] = 99; }
  const f = pushPull(v, k, w, h);
  assert.equal(f[0], v[0]);
  const mid = f[15 * w + 15];
  assert.ok(mid > 0.25 && mid < 0.65, `filled from its surroundings (${mid})`);
});

test('a near object over a far ground: one cut, the object, and depth behind it filled', () => {
  const { d, w, h } = scene();
  const s = chooseSplit(d, w, h);
  assert.ok(s && s.jump > 0.4, JSON.stringify(s));
  const { cuts } = planLayers(d, w, h);
  assert.equal(cuts.length, 1);
  const m = cuts[0].mask;
  assert.equal(m[32 * w + 45], 1); assert.equal(m[5 * w + 5], 0);
  const behind = fillBehind(d, m, w, h);
  assert.ok(behind[32 * w + 45] < 0.4, 'behind the object, the ground');
  const out = extendOutward(d, m, w, h, 2);
  assert.ok(out[32 * w + 70] > 0.8, 'the object depth carried beyond its edge');
});

test('a continuous scene is not cut', () => {
  const w = 64, h = 48, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = Math.floor(i / w) / h;
  assert.equal(planLayers(d, w, h).cuts.length, 0);
});

test('soft alpha follows the mask; decontaminated colours carry the inside outward', () => {
  const { d, w, h } = scene();
  const { cuts } = planLayers(d, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = cuts[0].mask[i] ? 0.8 : 0.2;
  const a = softAlpha(cuts[0].mask, w, h, gray, w, h);
  assert.ok(a[32 * w + 45] > 0.95 && a[5 * w + 5] < 0.05);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = cuts[0].mask[i] ? 200 : 10; rgba[i * 4 + 3] = 255; }
  const out = decontaminate(rgba, a, w, h);
  assert.ok(out[(5 * w + 5) * 4] > 150, 'outside the object, its own colour (with alpha 0)');
  assert.ok(out[(5 * w + 5) * 4 + 3] < 13);
  const b = borderSamples({ alpha: a, aw: w, ah: h, depth: d, dw: w, dh: h }, 10);
  assert.equal(b.length, 0, 'the object does not touch the edge of the photo');
  assert.equal(borderSamples({ depth: d, dw: w, dh: h }, 10).length, 44);
});

test('inpainting: the crop holds the hole with context, the inputs and the composite', () => {
  const w = 200, h = 100, hole = new Uint8Array(w * h);
  for (let y = 40; y < 60; y++) for (let x = 90; x < 110; x++) hole[y * w + x] = 1;
  const c = cropFor(hole, w, h);
  assert.ok(c.x <= 90 && c.x + c.w >= 110 && c.y <= 40 && c.y + c.h >= 60);
  assert.ok(c.ow % 8 === 0 && c.oh % 8 === 0 && Math.max(c.ow, c.oh) <= SIDE);
  const rgba = new Uint8ClampedArray(w * h * 4).fill(100);
  const { image, mask } = modelInputs(rgba, hole, w, c);
  assert.equal(image.length, 3 * c.ow * c.oh);
  assert.ok(mask.includes(0) && mask.includes(255));
  const painted = new Uint8Array(3 * c.ow * c.oh).fill(250);
  const soft = new Float32Array(w * h);
  for (let i = 0; i < soft.length; i++) soft[i] = hole[i];
  const out = composite(rgba, w, h, c, painted, soft);
  assert.equal(out[(50 * w + 100) * 4], 250, 'painted inside the hole');
  assert.equal(out[(10 * w + 10) * 4], 100, 'kept outside');
  assert.equal(cropFor(new Uint8Array(4), 2, 2), null);
});

test('depth model input: DPT size rule and normalisation', () => {
  const spec = depthSpec({ size: { height: 518, width: 518 }, ensure_multiple_of: 14, image_mean: [0.485, 0.456, 0.406], image_std: [0.229, 0.224, 0.225], keep_aspect_ratio: true, rescale_factor: 1 / 255 });
  assert.deepEqual(depthInputSize(960, 638, spec), [784, 518]);
  assert.deepEqual(depthInputSize(638, 960, spec), [518, 784]);
  const x = toDepthInput(Uint8ClampedArray.of(255, 0, 0, 255), 1, 1, spec);
  assert.ok(Math.abs(x[0] - (1 - 0.485) / 0.229) < 1e-5);
  assert.throws(() => depthSpec({}), { code: 'model-mismatch' });
});

test('options are completed and kept in range; sizes are even and standard', () => {
  const o = normalizeOptions({ preset: 'orbit', seconds: 99, aspect: '9:16', fps: 60, effects: { dof: 2 } });
  assert.deepEqual([o.preset, o.seconds, o.aspect, o.fps, o.effects.dof], ['orbit', SECONDS.max, '9:16', 60, 1]);
  const d = normalizeOptions({ preset: 'nope', fps: 7 });
  assert.deepEqual([d.preset, d.fps, d.aspect, d.seconds], ['dolly-in', 30, '16:9', 6]);
  assert.deepEqual(outputSize('16:9'), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize('9:16', 'standard'), { width: 720, height: 1280 });
  assert.deepEqual(outputSize('1:1'), { width: 1080, height: 1080 });
  assert.equal(autoQuality({ mobile: true }), 'standard');
  assert.equal(autoQuality({ deviceMemory: 8 }), 'high');
  assert.deepEqual(JSON.parse(JSON.stringify(o)), o, 'plain data');
});

test('a soundtrack is fitted to the video: cut, or looped, and faded', async () => {
  const sr = 1000, tone = Float32Array.from({ length: 300 }, () => 0.5);
  const long = fitSoundtrack({ sampleRate: sr, channels: [tone] }, 1, { fadeOut: 0.1 });
  assert.equal(long.channels.length, 2);
  assert.equal(long.channels[0].length, 1000);
  assert.ok(long.channels[0][500] > 0.45, 'looped through the middle');
  assert.equal(long.channels[0][999], 0, 'faded out at the end');
  assert.equal(long.channels[0][0], 0, 'faded in');
  const cut = fitSoundtrack({ sampleRate: sr, channels: [tone, tone] }, 0.1);
  assert.equal(cut.channels[1].length, 100);
  assert.deepEqual(await soundtrackOf(null), null);
  await assert.rejects(soundtrackOf({ nope: 1 }), { code: 'unsupported-format' });
});

test('renderer helpers: half floats and the grid', () => {
  assert.equal(toHalf(0), 0); assert.equal(toHalf(1), 0x3c00); assert.equal(toHalf(0.5), 0x3800); assert.equal(toHalf(-2), 0xc000);
  const g = gridMesh(3, 2);
  assert.equal(g.uv.length, 12); assert.equal(g.index.length, 12);
  assert.deepEqual([g.uv[4], g.uv[5]], [1, 0]);
});
