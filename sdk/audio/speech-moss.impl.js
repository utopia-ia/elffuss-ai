// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Speech in Spanish with MOSS-TTS-Nano (OpenMOSS, Apache-2.0), from its official
// ONNX export: the global transformer (prefill, then one decode step per frame
// with its key/value cache), the local graph that samples a frame of 16 codes
// with the settings it was exported with, and the codec's decoder. The voice is
// a voice prompt shipped as codes (moss-voice-*.js), so no audio is encoded here.
//
// The token-by-token part (the prefill and every frame) runs on the Elffuss
// Engine's port of the model: on WebGPU, or without it on the engine's
// WebAssembly kernels. It reads its weights from the same two .data files and
// samples as the official graph does, with the same uniform numbers, so the frames
// are those of the official graphs, which ONNX Runtime runs only where the
// engine's kernels cannot (no WebAssembly SIMD). The codec is ONNX Runtime's
// WebAssembly always.

import { AiError } from '../core/errors.js';
import { parseModel, createTokenizer, nmtNfkc } from './spm.js';
import { createRng, randomSeed, isSeed } from './rng.js';
import { MOSS_SAMPLE_RATE, MOSS_VOICES, MAX_FRAMES, MAX_READS, mossVoice, cleanText, chunkText, cloneRows, frameRow, frameInputs, toMono, endedEarly, uniformsDrawn, uniformStream } from './moss.js';
import { joinSpeech, measure } from './signal.js';
import { encodeWav } from './wav.js';

export const task = 'text-to-speech';
/** Longest text accepted, in characters. */
export const MAX_TEXT = 20000;
/** Frames the engine queues per submit (one readback each): the rest of a batch past the end is dropped. */
export const ENGINE_BATCH = 8;
/** Rows of a request the engine's CPU workspace takes at first; a longer request gets a larger one. */
export const CPU_ROWS = 512;

// The smallest module with a WebAssembly SIMD instruction (i8x16.popcnt of a v128 constant).
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
/** True when this realm runs WebAssembly SIMD, which the engine's CPU kernels need. */
export function hasWasmSimd(W = globalThis.WebAssembly) {
  try { return Boolean(W?.validate(SIMD_PROBE)); } catch { return false; }
}

/**
 * Threads for the engine's CPU kernels, by the engine's own rule (cpu.js,
 * hilosDisponibles): half the cores, at most 8, only with shared memory (a
 * cross-origin isolated page) and only inside a Worker, where its pool may wait
 * with Atomics.wait. Otherwise one.
 */
export function cpuThreads({ isolated = Boolean(globalThis.crossOriginIsolated), inWorker = typeof globalThis.WorkerGlobalScope !== 'undefined' && globalThis instanceof globalThis.WorkerGlobalScope, shared = typeof SharedArrayBuffer !== 'undefined', cores = globalThis.navigator?.hardwareConcurrency || 4 } = {}) {
  if (!isolated || !inWorker || !shared) return 1;
  return Math.max(1, Math.min(8, Math.floor(cores / 2)));
}

const FILES = Object.freeze({
  manifest: 'tts:browser_poc_manifest.json',
  meta: 'tts:tts_browser_onnx_meta.json',
  tokenizer: 'tts:tokenizer.model',
  prefill: 'tts:moss_tts_prefill.onnx',
  decode: 'tts:moss_tts_decode_step.onnx',
  frame: 'tts:moss_tts_local_fixed_sampled_frame.onnx',
  global: 'tts:moss_tts_global_shared.data',
  local: 'tts:moss_tts_local_shared.data',
  codecMeta: 'codec:codec_browser_onnx_meta.json',
  codec: 'codec:moss_audio_tokenizer_decode_full.onnx',
  codecData: 'codec:moss_audio_tokenizer_decode_shared.data',
});

/**
 * Check and complete the options of a run.
 * @param {{ text?: string, voice?: string, lang?: 'es', seed?: number }} input
 */
export function normalizeMossSpeech(input) {
  const text = String(input?.text ?? '').trim();
  if (!text) throw new AiError('unsupported-format', 'a text is needed');
  if (text.length > MAX_TEXT) throw new AiError('too-large', `the text has ${text.length} characters, at most ${MAX_TEXT}`);
  const voice = input?.voice ?? MOSS_VOICES[0].id;
  const v = mossVoice(voice);
  if (!v) throw new AiError('unsupported-format', `unknown voice ${voice}`, { details: { voices: MOSS_VOICES.map(x => x.id) } });
  const lang = input?.lang ?? v.lang;
  if (lang !== v.lang) throw new AiError('unsupported-format', `the voice ${voice} speaks ${v.lang}`);
  const seed = input?.seed == null ? randomSeed() : input.seed;
  if (!isSeed(seed)) throw new AiError('unsupported-format', 'seed must be an integer from 0 to 2147483647');
  return { text, lang, voice, seed };
}

/** A session of one graph and its shared weights file, on WebAssembly (the official browser runtime). */
async function session(ort, ctx, graph, data, name) {
  try {
    return await ort.InferenceSession.create(new Uint8Array(await ctx.bytes(graph)), {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all',
      externalData: [{ path: name, data }],
    });
  } catch (err) {
    throw new AiError(/memory|allocat|OOM/i.test(String(err?.message)) ? 'out-of-memory' : 'run-failed', `could not create a session of ${graph}`, { cause: err });
  }
}
const release = async s => { try { await s?.release(); } catch { /* gone */ } };
/** The file name a graph gives its external data under (the path after the part). */
const nameOf = ref => ref.slice(ref.indexOf(':') + 1).split('/').pop();

/** A WebGPU device of its own for the engine: no optional feature (the port needs none), the adapter's buffer limits. */
async function gpuDevice() {
  const adapter = await globalThis.navigator?.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new AiError('webgpu-unavailable', 'no WebGPU adapter for the engine');
  const L = adapter.limits;
  try {
    return await adapter.requestDevice({
      label: 'elffuss-ai moss',
      requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize, maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage },
    });
  } catch (err) {
    throw new AiError('webgpu-unavailable', 'the engine could not get a WebGPU device', { cause: err });
  }
}

const loadFailed = err => new AiError(/memory|allocat|OOM/i.test(String(err?.message)) ? 'out-of-memory' : 'run-failed', 'the engine could not load MOSS-TTS-Nano', { cause: err });

/**
 * The engine's source of weights: each tensor read from the stored .data files. The
 * engine may keep the source alive as long as the model; the files behind it (whole in
 * memory the first time they are checked) are let go by `release` once the weights are up.
 */
async function weights(ctx, eng) {
  const revision = ctx.model.parts?.tts?.revision || '';
  if (!eng.MOSS_ONNX_REVISION || !revision.startsWith(eng.MOSS_ONNX_REVISION)) {
    throw new AiError('model-mismatch', `the engine maps the weights of revision ${eng.MOSS_ONNX_REVISION}, the registry pins ${revision.slice(0, 8)}`);
  }
  const live = { [nameOf(FILES.global)]: await ctx.ranged(FILES.global), [nameOf(FILES.local)]: await ctx.ranged(FILES.local) };
  const files = Object.fromEntries(Object.entries(live).map(([k, f]) => [k, { size: f.size, slice: (o, n) => live[k].slice(o, n) }]));
  return { source: eng.fuenteOnnx(files, eng.MOSS_ONNX_MAPA), release() { for (const k of Object.keys(live)) delete live[k]; } };
}

/** The engine's port of the model on WebGPU. */
async function loadEngine(ctx) {
  const eng = await ctx.engine('gpu');
  const w = await weights(ctx, eng);
  const device = await gpuDevice();
  try {
    return { eng, device, model: await eng.cargaMoss(w.source, device) };
  } catch (err) {
    device.destroy();
    throw loadFailed(err);
  } finally {
    w.release();
  }
}

/** The engine's port of the model on its WebAssembly kernels, with room for requests of `rows` rows. */
async function loadCpu(ctx, rows = CPU_ROWS) {
  const [cpu, eng] = [await ctx.engine('cpu'), await ctx.engine('gpu')];   // the reader of the .data files lives in moss.js
  const w = await weights(ctx, eng);
  try {
    const model = await cpu.cargaMossCpu(w.source, { hilos: cpuThreads(), maxFilas: rows, maxContexto: rows + MAX_FRAMES });
    return { model, rows, ctx };
  } catch (err) {
    throw loadFailed(err);
  } finally {
    w.release();
  }
}

export async function load(ctx) {
  const ort = await ctx.ort();
  const manifest = JSON.parse(await ctx.text(FILES.manifest));
  const meta = JSON.parse(await ctx.text(FILES.meta));
  const codecMeta = JSON.parse(await ctx.text(FILES.codecMeta));
  const tok = createTokenizer(parseModel(await ctx.bytes(FILES.tokenizer)), { normalize: nmtNfkc });
  const state = { ort, manifest, meta, codecMeta, tok, prefill: null, decode: null, frame: null, codec: null, engine: null, cpu: null, ran: 'wasm' };
  try {
    if (ctx.device === 'webgpu') {
      state.engine = await loadEngine(ctx);
      state.ran = 'webgpu-engine';
    } else if (hasWasmSimd() && !ctx.test?.ortFrames) {
      // Test builds: `ortFrames` keeps the official graphs on ONNX Runtime, to compare.
      state.cpu = await loadCpu(ctx);
      state.ran = 'wasm-engine';
    } else {
      // No WebAssembly SIMD: the official graphs (lazy files of the variant) on ONNX Runtime.
      const global = new Uint8Array(await ctx.bytes(FILES.global));
      state.prefill = await session(ort, ctx, FILES.prefill, global, nameOf(FILES.global));
      state.decode = await session(ort, ctx, FILES.decode, global, nameOf(FILES.global));
      state.frame = await session(ort, ctx, FILES.frame, new Uint8Array(await ctx.bytes(FILES.local)), nameOf(FILES.local));
    }
    state.codec = await session(ort, ctx, FILES.codec, new Uint8Array(await ctx.bytes(FILES.codecData)), nameOf(FILES.codecData));
    if (ctx.test?.failLoad) throw new AiError('run-failed', 'test hook: the load fails after the sessions exist');
  } catch (err) {
    await dispose(state);
    throw err;
  }
  return state;
}

const lastHidden = (t, ort) => {
  const [, T, H] = t.dims.length === 3 ? t.dims : [1, 1, t.dims.at(-1)];
  return new ort.Tensor('float32', t.data.slice((T - 1) * H, T * H), [1, H]);
};

/**
 * The frames of one chunk: prefill, then a frame and a decode step at a time, until
 * the model ends the chunk or `max` frames. `uniform` is a `uniformStream`: each
 * runtime takes from it the numbers the official runtime takes, no more.
 */
export async function generateFrames(state, rows, uniform, onFrame, test, max = MAX_FRAMES) {
  if (state.engine) return engineFrames(state.engine, rows, uniform, onFrame, test, max);
  if (state.cpu) return cpuFrames(state, rows, uniform, onFrame, test, max);
  return ortFrames(state, rows, () => uniform.next(), onFrame, test, max);
}

/**
 * The frames on the engine's CPU kernels: a frame at a time, drawing as the official
 * runtime draws. A request longer than the workspace gets a larger one first.
 */
async function cpuFrames(state, rows, uniform, onFrame, test, max) {
  if (rows.rows > state.cpu.rows && !test) state.cpu = await loadCpu(state.cpu.ctx, rows.rows);
  const { model, rows: room } = state.cpu;
  // The test hook: one row more than the workspace has, refused inside the engine.
  const data = test ? new Int32Array((room + 1) * (rows.data.length / rows.rows)) : rows.data;
  return model.genera(data, () => uniform.next(), { max, enTrama: n => onFrame?.(n) });
}

/**
 * The frames on the engine, a batch of frames per submit. The engine draws the
 * numbers of a whole batch; those of the frames after the end go back.
 */
async function engineFrames({ eng, model }, rows, uniform, onFrame, test, max) {
  const drawn = [];
  const draw = () => { const u = uniform.next(); drawn.push(u); return u; };
  // The test hook: a context with no room for the request, refused inside the engine.
  const m = test ? { ...model, global: null } : model;
  const got = await eng.generaTramasGPU(m, rows.data, draw, { max, lote: ENGINE_BATCH, enTrama: n => onFrame?.(n), ...(test ? { maxContexto: 1 } : {}) });
  uniform.giveBack(drawn.slice(uniformsDrawn(got.length, max)));
  return got;
}

/** The frames on ONNX Runtime: the official graphs, a frame and a decode step at a time. */
async function ortFrames(state, rows, uniform, onFrame, test, max) {
  const { ort, manifest, meta } = state;
  const width = manifest.tts_config.n_vq + 1, nvq = manifest.tts_config.n_vq;
  const codebook = meta.model_config.audio_codebook_sizes[0];
  const names = meta.onnx;
  const disposeAll = o => { for (const v of Object.values(o)) v?.dispose?.(); };
  let out = await state.prefill.run({
    input_ids: new ort.Tensor('int32', rows.data, [1, rows.rows, width]),
    attention_mask: new ort.Tensor('int32', new Int32Array(rows.rows).fill(1), [1, rows.rows]),
  });
  let hidden = lastHidden(out.global_hidden, ort);
  let past = Object.fromEntries(names.prefill_output_names.slice(1).map(n => [n.replace('present_', 'past_'), out[n]]));
  out.global_hidden.dispose?.();
  let valid = rows.rows;
  const seen = Array.from({ length: nvq }, () => new Uint8Array(codebook));
  const got = [];
  try {
    for (let step = 0; step < max; step++) {
      const { mask, assistant, audio } = frameInputs(seen, uniform, codebook);
      const f = await state.frame.run({
        global_hidden: hidden,
        repetition_seen_mask: new ort.Tensor('int32', mask, [1, nvq, codebook]),
        assistant_random_u: new ort.Tensor('float32', assistant, [1]),
        // The test hook feeds one number too few: the runtime itself refuses the shape.
        audio_random_u: test ? new ort.Tensor('float32', audio.subarray(1), [1, nvq - 1]) : new ort.Tensor('float32', audio, [1, nvq]),
      });
      const go = Number(f.should_continue.data[0]) !== 0;
      const frame = Array.from(f.frame_token_ids.data, Number);
      disposeAll(f);
      if (!go) break;
      frame.forEach((code, q) => { if (code >= 0 && code < codebook) seen[q][code] = 1; });
      got.push(frame);
      onFrame?.(got.length);
      const feeds = { input_ids: new ort.Tensor('int32', frameRow(manifest, frame), [1, 1, width]), past_valid_lengths: new ort.Tensor('int32', new Int32Array([valid]), [1]) };
      for (const n of names.decode_input_names.slice(2)) feeds[n] = past[n];
      const d = await state.decode.run(feeds);
      disposeAll(past); hidden.dispose?.();
      hidden = lastHidden(d.global_hidden, ort);
      d.global_hidden.dispose?.();
      past = Object.fromEntries(names.decode_output_names.slice(1).map(n => [n.replace('present_', 'past_'), d[n]]));
      valid += 1;
    }
  } finally {
    disposeAll(past); hidden?.dispose?.();
  }
  return got;
}

/** The waveform of a chunk's frames, mono. */
async function decodeAudio(state, got) {
  const { ort } = state;
  if (!got.length) return new Float32Array(0);
  const codes = new Int32Array(got.length * got[0].length);
  got.forEach((f, i) => codes.set(f, i * f.length));
  const out = await state.codec.run({
    audio_codes: new ort.Tensor('int32', codes, [1, got.length, got[0].length]),
    audio_code_lengths: new ort.Tensor('int32', new Int32Array([got.length]), [1]),
  });
  const [, channels, samples] = out.audio.dims;
  const length = Math.min(samples, Number(out.audio_lengths.data[0]));
  const mono = toMono(out.audio.data, channels, samples, length);
  out.audio.dispose?.(); out.audio_lengths.dispose?.();
  return mono;
}

export async function run(state, input, opts, ctx) {
  const o = normalizeMossSpeech(input);
  const voice = mossVoice(o.voice);
  ctx.report('running', { stage: 'text' });
  const text = cleanText(o.text);
  const count = s => state.tok.encode(s).length;
  const chunks = chunkText(text, count);
  if (!chunks.length) throw new AiError('unsupported-format', 'the text has nothing to read');
  const rng = createRng(o.seed);
  const uniform = uniformStream(() => rng.uniform());
  const pieces = [];
  const codes = [];
  let framesTotal = 0, rereads = 0, framesMs = 0;
  for (let i = 0; i < chunks.length; i++) {
    ctx.report('running', { stage: 'chunk', chunk: i + 1, chunks: chunks.length });
    const rows = cloneRows(state.manifest, voice.codes.CODES, state.tok.encode(chunks[i].text));
    // A reading that ends too early for its text is done again (the same generator
    // goes on, so a seed still repeats the whole result); the longest is kept.
    let got = [];
    for (let read = 0; read < MAX_READS; read++) {
      const t0 = performance.now();
      const take = await generateFrames(state, rows, uniform, n => { if (n % 5 === 0) ctx.report('running', { stage: 'frame', chunk: i + 1, chunks: chunks.length, frames: n }); }, Boolean(opts?.test?.failRun));
      framesMs += performance.now() - t0;
      if (take.length > got.length) got = take;
      if (!endedEarly(chunks[i].text, got.length)) break;
      rereads++;
    }
    framesTotal += got.length;
    codes.push(got);
    ctx.report('running', { stage: 'decode', chunk: i + 1, chunks: chunks.length });
    pieces.push({ samples: await decodeAudio(state, got), pause: chunks[i].pause });
  }
  const samples = joinSpeech(pieces, MOSS_SAMPLE_RATE);
  if (!samples.length) throw new AiError('run-failed', 'the model gave no audio');
  const stats = measure([samples], MOSS_SAMPLE_RATE);
  const blob = new Blob([encodeWav([samples], MOSS_SAMPLE_RATE)], { type: 'audio/wav' });
  ctx.report('done');
  return {
    value: {
      blob, mime: 'audio/wav', seconds: samples.length / MOSS_SAMPLE_RATE, sampleRate: MOSS_SAMPLE_RATE, channels: 1,
      model: ctx.modelId, device: state.ran, dtype: ctx.dtype, voice: o.voice, lang: o.lang, seed: o.seed,
      chunks: chunks.length, frames: framesTotal, rereads, texts: chunks.map(c => c.text), stats,
      // Test builds: the codes of every chunk (the runtimes must give the same) and the time of the frames.
      ...(ctx.test ? { codes, framesMs } : {}),
    },
    transfer: [],
  };
}

export async function dispose(state) {
  if (!state) return;
  for (const k of ['prefill', 'decode', 'frame', 'codec']) { await release(state[k]); state[k] = null; }
  try { state.engine?.device.destroy(); } catch { /* gone */ }
  state.engine = null;
  state.cpu = null;
}
