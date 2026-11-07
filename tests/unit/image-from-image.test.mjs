// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A picture made from another (SDEdit with SANA-Sprint): the strength's start time, the
// size that keeps the picture's shape, the request with a picture, the pixels the page
// hands over, whether a model can do it, and the sampler's start from the picture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRequest, strengthTime, sizeFromImage, DEFAULT_STRENGTH } from '../../sdk/text-to-image/request.js';
import { pixelsOf, canStartFromImage } from '../../sdk/text-to-image/index.js';
import { sdeditTimes, timesteps, MAX_TIME } from '../../sdk/text-to-image/schedule.js';
import { generate } from '../../sdk/text-to-image/pipeline.js';
import { FILES } from '../../sdk/text-to-image/impl.js';

const registry = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
const picture = (w, h) => ({ width: w, height: h, rgba: new Uint8ClampedArray(w * h * 4) });

test('strength: a start time from 1.11 (the picture barely moves) to 1.55 (the text leads)', () => {
  assert.ok(Math.abs(strengthTime(0) - Math.atan(2)) < 1e-12);
  assert.ok(Math.abs(strengthTime(1) - Math.atan(60)) < 1e-12 && strengthTime(1) < Math.PI / 2, 'never all noise: the picture always hints');
  assert.ok(Math.abs(strengthTime(DEFAULT_STRENGTH) - 1.506) < 0.005, 'the default: a new light or style, the same layout');
  assert.ok(Math.abs(strengthTime(0.3) - 1.39) < 0.01, '0.3: small changes');
  for (let k = 0; k < 10; k++) assert.ok(strengthTime((k + 1) / 10) > strengthTime(k / 10), 'it grows with the strength');
  assert.equal(strengthTime(-1), strengthTime(0)); assert.equal(strengthTime(2), strengthTime(1), 'clamped');
});

test('size: about a megapixel, in the picture\'s shape, multiples of 8', () => {
  for (const [w, h] of [[1024, 1024], [4000, 3000], [1080, 1920], [640, 480], [3000, 1000]]) {
    const s = sizeFromImage(w, h);
    assert.equal(s.width % 8, 0); assert.equal(s.height % 8, 0);
    assert.ok(Math.abs(s.width / s.height - w / h) < 0.02, `${w}×${h}: shape kept (${s.width}×${s.height})`);
    assert.ok(s.width * s.height > 0.85e6 && s.width * s.height < 1.15e6, 'about a megapixel');
  }
});

test('request: a picture to start from, its strength, two steps, the size from the picture', () => {
  const r = normalizeRequest({ prompt: 'as a watercolour', seed: 3, image: picture(40, 30) });
  assert.equal(r.strength, DEFAULT_STRENGTH); assert.equal(r.steps, 2);
  assert.ok(Math.abs(r.width / r.height - 4 / 3) < 0.02, 'the picture\'s shape');
  assert.ok(r.genWidth > 0 && r.genHeight > 0);
  assert.equal(normalizeRequest({ prompt: 'x', seed: 1, image: picture(4, 4), strength: 0 }).strength, 0);
  assert.throws(() => normalizeRequest({ prompt: 'x', image: picture(4, 4), strength: 1.5 }), /strength/);
  assert.throws(() => normalizeRequest({ prompt: 'x', image: { width: 4, height: 4, rgba: new Uint8Array(10) } }), /RGBA/);
  assert.throws(() => normalizeRequest({ prompt: '', image: picture(4, 4) }), /prompt/);
  assert.equal(normalizeRequest({ prompt: 'x', seed: 1 }).image, undefined, 'without a picture: as before');
});

test('pixels: a picture given as pixels is copied for the Worker (the caller keeps its own)', async () => {
  const own = picture(2, 1); own.rgba.set([1, 2, 3, 255, 4, 5, 6, 255]);
  const p = await pixelsOf(own);
  assert.deepEqual([p.width, p.height], [2, 1]);
  assert.ok(p.rgba instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8ClampedArray(p.rgba)], [...own.rgba]);
  assert.notEqual(p.rgba, own.rgba.buffer, 'a copy: transferring it leaves the caller\'s');
  await assert.rejects(pixelsOf({}), /picture to start from/);
});

test('model: only a variant with the image encoder can start from a picture', () => {
  const m = registry.models['text-to-image/sana-sprint-0.6b'];
  assert.equal(FILES.imageEncoder, 'onnx:vae_encoder/model_fp16.onnx');
  const has = canStartFromImage(m);
  assert.equal(has, m.devices.webgpu.some(v => v.files.includes(FILES.imageEncoder)), 'as the registry says');
  const withEncoder = { ...m, devices: { webgpu: m.devices.webgpu.map(v => ({ ...v, files: [...v.files, FILES.imageEncoder] })) } };
  assert.equal(canStartFromImage(withEncoder), true);
  assert.equal(canStartFromImage(null), false);
});

test('SDEdit: the two-step schedule scaled to start at t; the picture noised there', async () => {
  const s = sdeditTimes(1.45);
  assert.equal(s.length, 3); assert.equal(s[2], 0);
  assert.ok(Math.abs(s[0] - 1.45) < 1e-6 && Math.abs(s[1] - 1.45 * 1.3 / MAX_TIME) < 1e-5);
  assert.deepEqual([...sdeditTimes(MAX_TIME)], [...timesteps(2)].map((v, i) => (i === 1 ? Math.fround(MAX_TIME * 1.3 / MAX_TIME) : v)));
  assert.throws(() => sdeditTimes(0)); assert.throws(() => sdeditTimes(2));
  // stand-in models: what the first step is given, from a start near 0, is the picture itself
  const n = 4 * 2 * 2;
  const init = Float32Array.from({ length: n }, (_, i) => (i % 5) - 2);
  const seen = [];
  const m = {
    encode: () => [1, 2], embed: () => new Float32Array(2 * 4), hidden: 4,
    runEncoder: async () => new Float32Array(2 * 4),
    runTransformer: async o => { seen.push(Float32Array.from(o.latents)); return new Float32Array(o.latents.length); },
    runDecoder: async (z, h, w) => ({ data: new Float32Array(3 * h * 32 * w * 32), height: h * 32, width: w * 32 }),
    config: { channels: 4, factor: 32, scaling: 1, guidance: 4.5, sigmaData: 0.5 },
  };
  const req = { prompt: 'x', seed: 1, steps: 2, width: 64, height: 64, genWidth: 64, genHeight: 64 };
  const x0s = [];
  await generate(m, { ...req, init: { latents: init, t: 0.05 } }, { onX0: x0 => { x0s.push(Float32Array.from(x0)); } });
  assert.equal(seen.length, 2, 'two steps'); assert.equal(x0s.length, 1, 'one preview, after the first step');
  assert.ok(seen[0].every((v, i) => Math.abs(v - init[i]) < 0.15 * (1 + Math.abs(init[i]))), 'near t = 0 the model is given the picture');
  const far = []; m.runTransformer = async o => { far.push(Float32Array.from(o.latents)); return new Float32Array(o.latents.length); };
  await generate(m, { ...req, init: { latents: init, t: MAX_TIME } });
  assert.ok(far[0].some((v, i) => Math.abs(v - init[i]) > 0.3), 'at π/2 the picture is all noise');
  await assert.rejects(generate(m, { ...req, init: { latents: new Float32Array(3), t: 1 } }), /latents have 3 values/);
});
