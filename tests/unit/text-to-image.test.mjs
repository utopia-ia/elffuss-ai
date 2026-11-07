// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The text-to-image task without a browser or a model: noise exactly as
// PyTorch's CPU generator draws it, the sampler's times and steps, the caption
// window over the Gemma tokens, the trained sizes, the resize and crop, the
// 4-bit token table, the request checks, and the pipeline with stand-in models.
// Reference numbers come from PyTorch and diffusers (tests/fixtures/text-to-image/,
// see SOURCES.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Mt19937, randn, MAX_SEED } from '../../sdk/text-to-image/rng.js';
import { timesteps, modelInput, step } from '../../sdk/text-to-image/schedule.js';
import { captionTokens, INSTRUCTION, normalizePrompt } from '../../sdk/text-to-image/prompt.js';
import { nearestTrained, resolveSize, ASPECTS, TRAINED_SIZES } from '../../sdk/text-to-image/shapes.js';
import { resizeCrop, toRgba, embedRows, halfToFloat } from '../../sdk/text-to-image/pixels.js';
import { normalizeRequest, DEFAULT_STEPS } from '../../sdk/text-to-image/request.js';
import { generate } from '../../sdk/text-to-image/pipeline.js';
import { estimate } from '../../sdk/text-to-image/index.js';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/text-to-image/${name}`, import.meta.url), 'utf8'));
const ref = fixture('reference.json');
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test('noise: the same numbers as torch.randn with a seeded CPU generator, also in later draws', () => {
  const gens = new Map();
  for (const c of ref.randn) {
    if (!gens.has(c.seed)) gens.set(c.seed, new Mt19937(c.seed));
    const x = randn(gens.get(c.seed), c.n);
    c.head.forEach((v, i) => close(x[i], v, 1e-6, `seed ${c.seed} n ${c.n} [${i}]`));
    c.tail.forEach((v, i) => close(x[c.n - 20 + i], v, 1e-6, `seed ${c.seed} n ${c.n} tail [${i}]`));
    close(x.reduce((s, v) => s + v, 0), c.sum, 1e-3, `seed ${c.seed} n ${c.n} sum`);
  }
  assert.throws(() => randn(new Mt19937(1), 8), RangeError);
  assert.equal(MAX_SEED, 4294967295);
});

test('sampler: the times of 1 to 4 steps and one step match diffusers', () => {
  for (const [steps, times] of Object.entries(ref.timesteps)) {
    const t = timesteps(Number(steps));
    assert.equal(t.length, times.length);
    times.forEach((v, i) => close(t[i], v, 1e-6, `steps ${steps} [${i}]`));
  }
  assert.throws(() => timesteps(5), RangeError);
  const latents = Float32Array.from(ref.step.latents), output = Float32Array.from(ref.step.output), noise = Float32Array.from(ref.step.noise);
  for (const c of ref.step.cases) {
    const { input, time, scale } = modelInput(latents, Math.fround(c.s));
    close(time, c.time, 1e-5, 'time');
    c.input.forEach((v, i) => close(input[i], v, 1e-5, `input [${i}]`));
    const { x0, next } = step({ latents, input, output, time, scale, s: Math.fround(c.s), t: Math.fround(c.t), noise });
    c.x0.forEach((v, i) => close(x0[i], v, 1e-5, `x0 [${i}]`));
    c.next.forEach((v, i) => close(next[i], v, 1e-5, `next [${i}]`));
  }
});

test('prompt: the instruction, the lowercase prompt, and the window of states the pipeline keeps', () => {
  const toks = fixture('tokens.json');
  const instruction = INSTRUCTION.join('\n');
  for (const c of toks.cases) {
    const table = new Map([[instruction, toks.instruction], [instruction + normalizePrompt(c.prompt), c.ids.concat(c.truncatedRest || [])]]);
    const encode = text => { const v = table.get(text); assert.ok(v, 'unexpected text to encode'); return v; };
    const out = captionTokens(encode, c.prompt);
    assert.deepEqual(out.ids, c.ids, c.prompt.slice(0, 30));
    assert.deepEqual(out.keep, c.keep, c.prompt.slice(0, 30));
    assert.equal(out.promptTokens, c.keep.length - 1);
  }
  assert.equal(normalizePrompt('  A Red FOX '), 'a red fox');
  // A prompt longer than the model reads: cut to the instruction plus 298 tokens.
  const long = toks.cases.find(c => c.prompt.startsWith('word'));
  assert.equal(long.ids.length, toks.instruction.length + 298);
});

test('sizes: the presets are trained sizes; other sizes go to the nearest trained shape as in diffusers', () => {
  for (const a of Object.values(ASPECTS)) assert.ok(Object.values(TRAINED_SIZES).some(([h, w]) => h === a.height && w === a.width));
  for (const [w, h, gh, gw] of ref.bins) assert.deepEqual(nearestTrained(w, h), { height: gh, width: gw }, `${w}×${h}`);
  assert.deepEqual(resolveSize({}), { width: 1024, height: 1024, genWidth: 1024, genHeight: 1024, aspect: '1:1' });
  assert.deepEqual(resolveSize({ aspect: '16:9' }), { width: 1344, height: 768, genWidth: 1344, genHeight: 768, aspect: '16:9' });
  assert.deepEqual(resolveSize({ width: 1920, height: 1080 }), { width: 1920, height: 1080, genWidth: 1344, genHeight: 768, aspect: null });
  assert.throws(() => resolveSize({ aspect: '5:4' }), RangeError);
  assert.throws(() => resolveSize({ width: 100, height: 100 }), RangeError);
});

test('pixels: resize and crop like torch, clamp and round to bytes, read the 4-bit token table', () => {
  const r = ref.resize;
  const out = resizeCrop(Float32Array.from(r.in), 3, r.h, r.w, r.width, r.height);
  r.out.forEach((v, i) => close(out[i], v, 1e-5, `resize [${i}]`));
  const same = new Float32Array(12);
  assert.equal(resizeCrop(same, 3, 2, 2, 2, 2), same);
  assert.deepEqual([...toRgba(Float32Array.of(-1, 1, 0, -2, 2, 0.5), 2, 1)], [0, 128, 255, 255, 255, 0, 191, 255]);
  assert.equal(halfToFloat(0x3c00), 1);
  assert.equal(halfToFloat(0xc000), -2);
  close(halfToFloat(0x2e66), 0.0999755859375, 0, 'half');
  // One row of 32: values -8…7 then 7…-8 (stored plus 8), scale 0.5.
  const packed = new Uint8Array(32), scales = new Uint16Array(2);
  const vals = [...Array.from({ length: 16 }, (_, i) => i - 8), ...Array.from({ length: 16 }, (_, i) => 7 - i)];
  for (let k = 0; k < 16; k++) packed[16 + k] = (vals[2 * k] + 8) | ((vals[2 * k + 1] + 8) << 4);
  scales[1] = 0x3800;
  assert.deepEqual([...embedRows(packed, scales, [1], 32)], vals.map(v => v * 0.5));
});

test('requests: defaults, a random seed when none is given, and refusals with input codes', () => {
  const r = normalizeRequest({ prompt: '  a fox  ', seed: 7 });
  assert.deepEqual(r, { prompt: 'a fox', seed: 7, steps: DEFAULT_STEPS, width: 1024, height: 1024, genWidth: 1024, genHeight: 1024, aspect: '1:1' });
  const s = normalizeRequest({ prompt: 'x' }).seed;
  assert.ok(Number.isInteger(s) && s >= 0 && s <= MAX_SEED);
  assert.equal(normalizeRequest({ prompt: 'x', seed: 1, aspect: '9:16', steps: 4 }).genHeight, 1344);
  for (const bad of [null, {}, { prompt: '   ' }, { prompt: 'x', steps: 8 }, { prompt: 'x', seed: -1 }, { prompt: 'x', seed: 1.5 }, { prompt: 'x', aspect: '7:5' }]) {
    assert.throws(() => normalizeRequest(bad), e => e.code === 'unsupported-format', JSON.stringify(bad));
  }
  assert.throws(() => normalizeRequest({ prompt: 'x'.repeat(3000) }), { code: 'too-large' });
  // A chat's tool call maps onto it as it is.
  const call = JSON.parse('{"tool":"image.generate","args":{"prompt":"a lighthouse","aspect":"16:9","seed":7}}');
  assert.equal(normalizeRequest(call.args).genWidth, 1344);
});

test('pipeline: stand-in models get the right shapes, stages are reported, the size is cropped', async () => {
  const calls = [];
  const models = {
    encode: text => Array.from({ length: text.startsWith(INSTRUCTION.join('\n')) && text.length > INSTRUCTION.join('\n').length ? 12 : 9 }, (_, i) => i + 2),
    embed: ids => new Float32Array(ids.length * 4).fill(1),
    hidden: 4,
    runEncoder: async (e, n) => { calls.push(['encoder', n]); return Float32Array.from({ length: n * 4 }, (_, i) => Math.floor(i / 4)); },
    runTransformer: async o => { calls.push(['transformer', o.h, o.w, o.tokens, o.caption.slice(0, 8)]); return new Float32Array(o.latents.length); },
    runDecoder: async (z, h, w) => { calls.push(['decoder', h, w]); return { data: new Float32Array(3 * h * 32 * w * 32), height: h * 32, width: w * 32 }; },
    config: { channels: 32, factor: 32, scaling: 0.41407, guidance: 0.45 },
  };
  const stages = [];
  const out = await generate(models, { prompt: 'x', seed: 1, steps: 3, width: 1000, height: 600, genWidth: 1152, genHeight: 832 }, { report: (s, e) => stages.push(e?.step ? `${s} ${e.step}/${e.steps}` : s) });
  assert.deepEqual(stages, ['encode', 'step 1/3', 'step 2/3', 'step 3/3', 'decode']);
  assert.deepEqual(calls[0], ['encoder', 12]);
  // The first state and the prompt's window: positions 0 and 8 to 11 of 12 (instruction of 9 tokens).
  assert.deepEqual(calls[1].slice(0, 4), ['transformer', 26, 36, 5]);
  assert.deepEqual([...calls[1][4]], [0, 0, 0, 0, 8, 8, 8, 8]);
  assert.deepEqual(calls.at(-1), ['decoder', 26, 36]);
  assert.equal(out.width, 1000);
  assert.equal(out.rgba.length, 1000 * 600 * 4);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(generate(models, { prompt: 'x', seed: 1, steps: 1, width: 1024, height: 1024, genWidth: 1024, genHeight: 1024 }, { signal: ac.signal }), { code: 'aborted' });
});

test('estimate: what it downloads, what the store lacks, and who cannot run it', async () => {
  const registry = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
  const store = { has: async url => url.endsWith('.json') };
  const gpu = { available: true, shaderF16: true, fallbackAdapter: false };
  const e = await estimate({ registry, store, probe: gpu, mobile: false });
  assert.equal(e.fits, true);
  assert.equal(e.device, 'webgpu');
  assert.equal(e.downloadBytes, registry.models['text-to-image/sana-sprint-0.6b'].devices.webgpu[0].bytes);
  assert.ok(e.missingBytes > 0 && e.missingBytes < e.downloadBytes);
  assert.equal((await estimate({ registry, probe: { available: false, shaderF16: false }, mobile: false })).reason, 'webgpu-unavailable');
  assert.equal((await estimate({ registry, probe: { available: true, shaderF16: false }, mobile: false })).reason, 'shader-f16');
  assert.equal((await estimate({ registry, probe: gpu, mobile: true })).reason, 'memory');
  assert.equal((await estimate({ registry, probe: gpu, mobile: false })).missingBytes, null);
});
