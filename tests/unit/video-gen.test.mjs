// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The text-to-video task's pure helpers against the reference side (Python,
// tests/fixtures/video-gen/reference.json): the noise both sides draw, T5's
// position buckets, the sampler's times; and the latent's reorderings, the
// embedding table, the options, the half floats and the device estimate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gaussian, hash32 } from '../../sdk/video-gen/noise.js';
import { grid, framesFor, patchify, unpatchify, ropeTables, timeFrequencies } from '../../sdk/video-gen/latent.js';
import { SAMPLERS, flowTimes, step } from '../../sdk/video-gen/schedule.js';
import { relativeBuckets, gatherEmbeddings, padContext, ROW_BYTES } from '../../sdk/video-gen/t5.js';
import { toHalf, toHalfBits, fromHalfBits } from '../../sdk/video-gen/half.js';
import { normalizeOptions, SIZES } from '../../sdk/video-gen/options.js';
import { estimate, peakBytes, largestBuffer } from '../../sdk/video-gen/estimate.js';
import { cleanPrompt, createTokenizer } from '../../sdk/video-gen/tokenizer.js';

const ref = JSON.parse(readFileSync(new URL('../fixtures/video-gen/reference.json', import.meta.url), 'utf8'));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('noise: the same values as the reference generator, any slice equal to the whole', () => {
  const n = gaussian(ref.noise.seed, ref.noise.stream, 4000);
  ref.noise.first.forEach((v, i) => close(n[i], v, 1e-6, `value ${i}`));
  ref.noise.at3001.forEach((v, i) => close(n[3001 + i], v, 1e-6, `value ${3001 + i}`));
  const slice = gaussian(ref.noise.seed, ref.noise.stream, 4, { offset: 3001 });
  assert.deepEqual([...slice], [...n.subarray(3001, 3005)], 'an odd offset gives the same values');
  ref.noise2.first.forEach((v, i) => close(gaussian(ref.noise2.seed, ref.noise2.stream, 10)[i], v, 1e-6, 'large seed'));
  let m = 0, s = 0; for (const v of n) { m += v; s += v * v; }
  m /= n.length; close(Math.sqrt(s / n.length - m * m), 1, 0.05, 'standard deviation');
  assert.notDeepEqual([...gaussian(1, 0, 4)], [...gaussian(1, 1, 4)], 'streams differ');
  assert.equal(hash32(0), 0);
});

test('grid: sizes, frames 1 + 4k, tokens', () => {
  const g = grid({ width: 832, height: 480, frames: 33 });
  assert.deepEqual([g.f, g.h, g.w, g.tokensPerFrame, g.tokens, g.latentSize], [9, 60, 104, 1560, 14040, 16 * 9 * 60 * 104]);
  assert.throws(() => grid({ width: 830, height: 480, frames: 33 }), RangeError);
  assert.throws(() => grid({ width: 832, height: 480, frames: 32 }), RangeError);
  assert.deepEqual([1, 2, 3, 5].map(framesFor), [17, 33, 49, 81]);
});

test('patchify and unpatchify: the transformer orders (c, dy, dx) in and (dy, dx, c) out', () => {
  const g = grid({ width: 32, height: 16, frames: 5 });
  const z = Float32Array.from({ length: g.latentSize }, (_, i) => i);
  const tok = patchify(z, g);
  assert.equal(tok.length, g.tokens * 64);
  // token 0 = frame 0, row 0, col 0: channel 0's 2 × 2 pixels first
  assert.deepEqual([...tok.subarray(0, 4)], [0, 1, 4, 5]);
  // unpatchify of a (dy, dx, c) reordering gives the latent back
  const out = new Float32Array(tok.length);
  for (let t = 0; t < g.tokens; t++) for (let c = 0; c < 16; c++) for (let p = 0; p < 4; p++) out[t * 64 + p * 16 + c] = tok[t * 64 + c * 4 + p];
  assert.deepEqual([...unpatchify(out, g)], [...z]);
  const part = patchify(z, g, 1, 1);
  assert.deepEqual([...part], [...tok.subarray(g.tokensPerFrame * 64, 2 * g.tokensPerFrame * 64)], 'one frame of the tokens');
});

test('rotary tables and the time sinusoid', () => {
  const g = grid({ width: 64, height: 32, frames: 9 });
  const { cos, sin } = ropeTables(g, 2, 1);
  assert.equal(cos.length, g.tokensPerFrame * 64);
  close(cos[0], Math.cos(2), 1e-6, 'time angle of frame 2, first frequency');
  close(sin[22], 0, 0, 'row 0');
  const t = timeFrequencies(1000);
  close(t[0], Math.cos(1000), 1e-6, 'cos'); close(t[128], Math.sin(1000), 1e-6, 'sin');
});

test('sampler: rCM times as TurboDiffusion computes them; steps end on the clean estimate', () => {
  const t = flowTimes(SAMPLERS.rcm, 4);
  ref.rcmTimes4.forEach((v, i) => close(t[i], v, 1e-12, `time ${i}`));
  assert.deepEqual(flowTimes(SAMPLERS.rcm, 1).length, 2);
  assert.throws(() => flowTimes(SAMPLERS.rcm, 5), RangeError);
  const sf = flowTimes(SAMPLERS.selfForcing, 4);
  [1, 0.9375, 5 / 6, 0.625, 0].forEach((v, i) => close(sf[i], v, 1e-12, `self forcing ${i}`));
  const x = Float32Array.of(1, 2), v = Float32Array.of(0.5, -1);
  step(x, v, 0.8, 0, null);
  close(x[0], 0.6, 1e-6, 'x0'); close(x[1], 2.8, 1e-6, 'x0');
  const y = Float32Array.of(1), noise = Float32Array.of(2);
  step(y, Float32Array.of(0), 0.5, 0.25, noise);
  close(y[0], 0.75 * 1 + 0.25 * 2, 1e-6, 'noise put back');
  assert.throws(() => step(Float32Array.of(1), Float32Array.of(1), 0.5, 0.2, null), RangeError);
});

test('T5 buckets: the same as Wan\'s relative embedding', () => {
  const b = relativeBuckets(300);
  ref.buckets300.rows.forEach((r, k) => assert.deepEqual(Array.from(b.subarray(r * 300, (r + 1) * 300), Number), ref.buckets300.values[k], `row ${r}`));
});

test('embedding table: 4-bit blocks with scale and zero, gathered row by row', () => {
  const dim = 64, vocab = 3, rowBytes = dim / 2 + (dim / 32) * 2 + dim / 64;
  const table = new Uint8Array(vocab * rowBytes);
  const dv = new DataView(table.buffer);
  // row 2: values q = j % 16, scales 0.5 and 2, zeros 3 and 7
  const row = 2 * rowBytes;
  for (let j = 0; j < dim / 2; j++) table[row + j] = ((2 * j) % 16) | (((2 * j + 1) % 16) << 4);
  dv.setUint16(row + dim / 2, toHalfBits(0.5), true); dv.setUint16(row + dim / 2 + 2, toHalfBits(2), true);
  table[row + dim / 2 + 4] = 3 | (7 << 4);
  const e = gatherEmbeddings(table, [2, 0], { dim, vocab });
  assert.equal(e.length, 2 * dim);
  for (let i = 0; i < dim; i++) close(e[i], ((i % 16) - (i < 32 ? 3 : 7)) * (i < 32 ? 0.5 : 2), 0, `value ${i}`);
  assert.ok(e.subarray(dim).every(v => v === 0));
  assert.throws(() => gatherEmbeddings(table, [3], { dim, vocab }), RangeError);
  assert.throws(() => gatherEmbeddings(new Uint8Array(5), [0], { dim, vocab }), RangeError);
  assert.equal(ROW_BYTES, 2048 + 256 + 64);
  const padded = padContext(Float32Array.of(1, 2, 3, 4), 2, { len: 3, dim: 2 });
  assert.deepEqual([...padded], [1, 2, 3, 4, 0, 0]);
});

test('half floats: round to nearest even, specials, round trip', () => {
  assert.equal(toHalfBits(1), 0x3c00);
  assert.equal(toHalfBits(-2), 0xc000);
  assert.equal(toHalfBits(65504), 0x7bff);
  assert.equal(toHalfBits(1e6), 0x7c00);
  assert.equal(toHalfBits(2 ** -24), 1);
  assert.ok(Number.isNaN(fromHalfBits(toHalfBits(NaN))));
  for (const v of [0.1, -3.14159, 1 / 3, 1e-5, 1234.5]) close(fromHalfBits(toHalfBits(v)), v, Math.max(Math.abs(v) * 1e-3, 2 ** -24), `round trip ${v}`);
  assert.deepEqual([...toHalf([1, 0])], [0x3c00, 0]);
});

test('options: defaults, sizes, seconds, steps, seed; errors are AiErrors', () => {
  const o = normalizeOptions({ prompt: '  a fox  ' });
  assert.deepEqual([o.prompt, o.size, o.frames, o.seconds, o.steps, o.seed], ['a fox', SIZES[0], 33, 2, 4, null]);
  assert.equal(normalizeOptions({ prompt: 'x', size: '480 × 832', seconds: 5 }).frames, 81);
  for (const bad of [{}, { prompt: 'x', size: '1920x1080' }, { prompt: 'x', seconds: 9 }, { prompt: 'x', steps: 0 }, { prompt: 'x', seed: -1 }]) {
    assert.throws(() => normalizeOptions(bad), e => e.name === 'AiError');
  }
});

const registry = {
  schema: 1, tasks: { 'text-to-video': { default: 'text-to-video/m' } },
  models: { 'text-to-video/m': { task: 'text-to-video', parts: { web: { repo: 'a/b', revision: 'c'.repeat(40), files: {
    'dit/part0.onnx': { size: 10 }, 'dit/part0.onnx_data': { size: 1000 }, 't5/encoder_0.onnx': { size: 5 }, 't5/encoder_0.onnx_data': { size: 500 },
    't5/embed_q4.bin': { size: 300 }, 'vae/taew2_1_light.onnx': { size: 40 } } } },
  devices: { webgpu: [{ when: 'shader-f16', dtype: 'q8f16', files: ['web:dit/part0.onnx', 'web:dit/part0.onnx_data', 'web:t5/encoder_0.onnx', 'web:t5/encoder_0.onnx_data', 'web:t5/embed_q4.bin', 'web:vae/taew2_1_light.onnx'], bytes: 1855 }] } } },
};
const fakeGpu = ({ f16 = true, maxBufferSize = 4 * 2 ** 30, fallback = false, oom = false } = {}) => ({
  async requestAdapter() {
    return {
      info: { vendor: fallback ? 'google' : 'acme', architecture: '', description: fallback ? 'SwiftShader' : '' },
      features: new Set(f16 ? ['shader-f16'] : []),
      limits: { maxBufferSize, maxStorageBufferBindingSize: maxBufferSize },
      async requestDevice() {
        let failed = false;
        return { pushErrorScope() {}, async popErrorScope() { return failed ? { message: 'oom' } : null; },
          createBuffer() { if (oom) failed = true; return { destroy() {} }; }, destroy() {} };
      },
    };
  },
});

test('estimate: honest reasons, download and missing bytes, a memory probe', async () => {
  const base = { registry, model: 'text-to-video/m' };
  let r = await estimate({ seconds: 2 }, { ...base, gpu: null });
  assert.deepEqual([r.fits, r.reason, r.downloadBytes, r.missingBytes], [false, 'no-webgpu', 1855, 1855]);
  r = await estimate({}, { ...base, gpu: fakeGpu({ f16: false }) });
  assert.equal(r.reason, 'no-shader-f16');
  r = await estimate({}, { ...base, gpu: fakeGpu({ fallback: true }) });
  assert.equal(r.reason, 'software-adapter');
  r = await estimate({ size: '832x480', seconds: 5 }, { ...base, gpu: fakeGpu({ maxBufferSize: 256 * 2 ** 20 }) });
  assert.equal(r.reason, 'buffers-too-small');
  r = await estimate({}, { ...base, gpu: fakeGpu({ oom: true }) });
  assert.equal(r.reason, 'not-enough-memory');
  const store = { async has(url) { return url.endsWith('part0.onnx_data'); } };
  r = await estimate({}, { ...base, gpu: fakeGpu(), store });
  assert.deepEqual([r.fits, r.reason, r.missingBytes, r.frames, r.tokens], [true, null, 855, 33, 14040]);
  assert.ok(r.memoryBytes > 0);
  assert.ok(largestBuffer(grid({ width: 832, height: 480, frames: 81 })) > largestBuffer(grid({ width: 832, height: 480, frames: 33 })));
  const p = peakBytes(grid({ width: 832, height: 480, frames: 33 }), { ditBytes: 1.5e9, encoderShardBytes: 7e8, embedBytes: 6e8, decoderBytes: 4e7 });
  assert.equal(p.peak, Math.max(p.transformer, p.encoder, p.decoder));
});

test('prompt cleaning as Wan does it', () => {
  assert.equal(cleanPrompt('  “Hi”   &amp;amp;\n\tﬁne  '), '"Hi" & fine');
  assert.equal(cleanPrompt('Ｆｕｌｌ\u0007'), 'Full');
});

// With the weight cache of the browser tests, the real vocabulary: every case as Wan's tokenizer gives it.
const cache = process.env.ELFFUSS_AI_CACHE;
const tokFile = cache && `${cache}/hf/Wan-AI/Wan2.1-T2V-1.3B/37ec512624d61f7aa208f7ea8140a131f93afc9a/google/umt5-xxl/tokenizer.json`;
test('tokenizer: the ids of Wan\'s Python tokenizer (needs the weight cache)', { skip: !(tokFile && existsSync(tokFile)) && 'no weight cache' }, () => {
  const tok = createTokenizer(JSON.parse(readFileSync(tokFile, 'utf8')));
  const cases = JSON.parse(readFileSync(new URL('../fixtures/video-gen/tokens.json', import.meta.url), 'utf8'));
  for (const c of cases) assert.deepEqual(tok.encode(c.text), c.ids, c.text);
});

test('tokenizer: Viterbi over a small vocabulary, unknowns fused, end token kept', () => {
  const tok = createTokenizer({ model: { type: 'Unigram', unk_id: 3, vocab: [['<pad>', 0], ['</s>', 0], ['<s>', 0], ['<unk>', 0], ['▁a', -1], ['▁ab', -1.5], ['b', -2], ['▁', -3], ['c', -2]] } });
  assert.deepEqual(tok.encode('ab'), [5, 1]);
  assert.deepEqual(tok.encode('a b'), [4, 7, 6, 1]);
  assert.deepEqual(tok.encode('a zz'), [4, 7, 3, 1], 'two unknown characters are one <unk>');
  assert.deepEqual(tok.encode(''), [1]);
  assert.equal(tok.encode('ab ab ab', { maxLength: 3 }).length, 3);
  assert.throws(() => createTokenizer({ model: { type: 'BPE' } }), TypeError);
});
