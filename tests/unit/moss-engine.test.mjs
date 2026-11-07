// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Elffuss's own voice on the Elffuss Engine, without a browser: the ranged reads
// the engine takes its weights through (over a Blob from the store, or bytes), the
// engine's reader of the official .data files over them, the context members a
// task uses for it, and the uniform numbers: the engine draws a whole batch of
// frames ahead, and gives back what the official runtime would not have drawn, so
// a seed reads a text the same way on both runtimes. The frames themselves are
// compared in the browser (tests/browser/specs/audio.spec.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { rangedFile } from '../../sdk/core/ranged.js';
import { Task } from '../../sdk/core/task.js';
import { pinnedUrl } from '../../sdk/core/hub-url.js';
import { VENDOR_DIRS } from '../../sdk/core/runtime-pins.js';
import { ENGINE_ENTRY } from '../../sdk/core/runtimes.js';
import { createRng } from '../../sdk/audio/rng.js';
import { N_VQ, uniformsDrawn, uniformStream } from '../../sdk/audio/moss.js';
import { generateFrames, ENGINE_BATCH } from '../../sdk/audio/speech-moss.impl.js';

const reg = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
const engineUrl = pathToFileURL(new URL(`../../vendor/${VENDOR_DIRS.engine}/${ENGINE_ENTRY}`, import.meta.url).pathname).href;
const bytesOf = n => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);

test('rangedFile: exact slices of a Blob, of an ArrayBuffer and of a view with an offset; nothing outside', async () => {
  const all = bytesOf(1000);
  const sources = { blob: new Blob([all]), buffer: all.slice().buffer, view: new Uint8Array(Uint8Array.from([9, 9, ...all]).buffer, 2, 1000) };
  for (const [name, src] of Object.entries(sources)) {
    const r = rangedFile(src, name);
    assert.equal(r.size, 1000, name);
    for (const [off, len] of [[0, 0], [0, 1000], [3, 17], [996, 4], [512, 256]]) {
      const got = await r.slice(off, len);
      assert.ok(got instanceof ArrayBuffer, `${name}: an ArrayBuffer`);
      assert.deepEqual(new Uint8Array(got), all.subarray(off, off + len), `${name} ${off}+${len}`);
    }
    const one = await r.slice(10, 4);
    new Uint8Array(one).fill(0);
    assert.deepEqual(new Uint8Array(await r.slice(10, 4)), all.subarray(10, 14), `${name}: a slice is a copy`);
    for (const [off, len] of [[-1, 4], [998, 4], [0, 1001], [1.5, 2], [0, -1], [Number.NaN, 1]]) {
      await assert.rejects(r.slice(off, len), { code: 'run-failed' }, `${name} ${off}+${len}`);
    }
  }
  assert.throws(() => rangedFile('text'), { code: 'run-failed' });
});

test('the engine reads a tensor of the official .data files through a ranged Blob: the top 16 bits of each f32, MatMul weights transposed', async () => {
  const eng = await import(engineUrl);
  // Two tensors in one file: a vector at 0 and a [2, 3] MatMul weight (ONNX [in, out]) at 16.
  const f32 = new Float32Array(4 + 6);
  f32.set([1.5, -2, 0.25, 3], 0);
  f32.set([1, 2, 3, 4, 5, 6], 4);
  const file = rangedFile(new Blob([f32.buffer]), 'x.data');
  const src = eng.fuenteOnnx({ 'x.data': file }, {
    v: { file: 'x.data', off: 0, len: 16, dims: [4], T: false },
    w: { file: 'x.data', off: 16, len: 24, dims: [2, 3], T: true },
  });
  const top = x => new Uint32Array(Float32Array.of(x).buffer)[0] >>> 16;
  assert.deepEqual([...await src.bf16('v')], [1.5, -2, 0.25, 3].map(top));
  assert.deepEqual([...await src.bf16('w')], [1, 4, 2, 5, 3, 6].map(top), '[out, in] for the engine');
  await assert.rejects(src.bf16('missing'));
  // The real map points inside the two pinned files of the registry, at their sizes.
  const files = reg.models['text-to-speech/moss-tts-nano'].parts.tts.files;
  assert.ok(reg.models['text-to-speech/moss-tts-nano'].parts.tts.revision.startsWith(eng.MOSS_ONNX_REVISION));
  for (const [name, d] of Object.entries(eng.MOSS_ONNX_MAPA)) {
    assert.ok(files[d.file], `${name}: ${d.file} is a pinned file`);
    assert.ok(d.off >= 0 && d.off + d.len <= files[d.file].size, `${name}: inside ${d.file}`);
  }
});

/** A registry where MOSS-TTS-Nano's tokenizer is a few known bytes, and a store that serves them. */
function tinyMoss() {
  const model = structuredClone(reg.models['text-to-speech/moss-tts-nano']);
  const data = Buffer.from(bytesOf(64));
  model.parts.tts.files['tokenizer.model'] = { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  for (const vs of Object.values(model.devices)) for (const v of vs) v.bytes = 0;
  const registry = { ...reg, models: { ...reg.models, 'text-to-speech/moss-tts-nano': model } };
  const url = pinnedUrl(model.parts.tts.repo, model.parts.tts.revision, 'tokenizer.model');
  const gets = [];
  const store = { has: async () => true, get: async (u, { bytes }) => { gets.push(u); assert.equal(u, url); assert.equal(bytes, data.length); return new Blob([data]); } };
  return { registry, store, data, gets };
}
const spec = impl => ({ task: 'text-to-speech', workerUrl: null, impl: async () => impl, prepare: async x => ({ value: x, transfer: [] }) });
const runtime = (engine = engineUrl) => ({ ortBundle: '/vendor/x.mjs', ortMjs: '/vendor/y.mjs', ortWasm: '/vendor/z.wasm', transformers: '/vendor/t.js', engine });

test('ctx.ranged reads a checked file of the variant by parts; ctx.engine gives the pinned engine, and only to a model that names it', async () => {
  const { registry, store, data, gets } = tinyMoss();
  let seen = null;
  const impl = {
    task: 'text-to-speech',
    async load(ctx) {
      const r = await ctx.ranged('tts:tokenizer.model');
      seen = { size: r.size, part: new Uint8Array(await r.slice(5, 9)) };
      await assert.rejects(ctx.ranged('tts:README.md'), { code: 'not-in-registry' });
      const eng = await ctx.engine();
      assert.equal(typeof eng.generaTramasGPU, 'function');
      return {};
    },
    async run() { return { value: null }; },
    async dispose() {},
  };
  await new Task(spec(impl), { worker: false, store, registry, runtime: runtime(), model: 'text-to-speech/moss-tts-nano' }).load();
  assert.equal(seen.size, data.length);
  assert.deepEqual(seen.part, new Uint8Array(data.subarray(5, 14)));
  assert.equal(gets.length, 1, 'one read from the store');

  // A site that does not ship the pinned engine, and a model that has no port in it.
  const noEngine = { ...impl, async load(ctx) { await assert.rejects(ctx.engine(), { code: 'runtime-mismatch' }); return {}; } };
  await new Task(spec(noEngine), { worker: false, store, registry, runtime: runtime('/vendor/elffuss-engine@000000000000/js/moss.js'), model: 'text-to-speech/moss-tts-nano' }).load();
  const kokoro = { ...impl, async load(ctx) { await assert.rejects(ctx.engine(), { code: 'not-in-registry' }); return {}; } };
  await new Task(spec(kokoro), { worker: false, store: { has: async () => true, get: async () => new Blob([]) }, registry: reg, runtime: runtime(), model: 'text-to-speech/kokoro-82m' }).load();
});

test('the uniform numbers: what the official runtime draws per chunk, and a stream that takes back what was drawn ahead', () => {
  assert.equal(uniformsDrawn(0, 375), N_VQ + 1, 'a chunk that ends at once still drew its first step');
  assert.equal(uniformsDrawn(40, 375), 41 * (N_VQ + 1));
  assert.equal(uniformsDrawn(375, 375), 375 * (N_VQ + 1), 'no step after the last one');
  let n = 0;
  const s = uniformStream(() => ++n);
  assert.deepEqual([s.next(), s.next(), s.next()], [1, 2, 3]);
  s.giveBack([2, 3]);
  assert.deepEqual([s.next(), s.next(), s.next(), s.next()], [2, 3, 4, 5]);
});

/**
 * An engine that draws as generaTramasGPU does (a batch of `lote` frames, N_VQ + 1
 * numbers each, before it knows where the chunk ends) and ends at frame `end`.
 */
const fakeEngine = end => ({
  generaTramasGPU: async (m, filas, uniforme, { max, lote, enTrama }) => {
    const out = [];
    for (;;) {
      const k = Math.min(lote, max - out.length);
      for (let i = 0; i < k * (N_VQ + 1); i++) uniforme();
      for (let i = 0; i < k; i++) {
        if (out.length === end) return out;
        out.push(Array(N_VQ).fill(out.length));
        enTrama?.(out.length, out.at(-1));
      }
      if (out.length >= max) return out;
    }
  },
});

test('the engine path takes from the run\'s numbers exactly what the official runtime takes, chunk after chunk', async () => {
  for (const [end, max] of [[0, 375], [1, 375], [ENGINE_BATCH - 1, 375], [ENGINE_BATCH, 375], [37, 375], [12, 12], [20, 12]]) {
    const ref = createRng(7);
    const run = createRng(7);
    const stream = uniformStream(() => run.uniform());
    const state = { engine: { eng: fakeEngine(end), model: {} } };
    const frames = [];
    const got = await generateFrames(state, { data: new Int32Array(17), rows: 1 }, stream, n => frames.push(n), false, max);
    assert.equal(got.length, Math.min(end, max), `end ${end}, max ${max}`);
    assert.deepEqual(frames, got.map((_, i) => i + 1), 'one progress call per frame');
    // The official runtime: N_VQ + 1 numbers per step, the step that ends included.
    for (let i = 0; i < uniformsDrawn(got.length, max); i++) ref.uniform();
    for (let i = 0; i < 3 * (N_VQ + 1); i++) assert.equal(stream.next(), ref.uniform(), `end ${end}, max ${max}: number ${i} after the chunk`);
  }
});
