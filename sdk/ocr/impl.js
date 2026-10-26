// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The OCR task where the model runs (a Worker): PP-OCR detection and
// recognition used directly with ONNX Runtime Web. Both models and both
// settings files come from the store through the task context, checked
// against the registry; the dictionary and the decoder are checked against the
// recogniser's outputs before anything is read. No fetch, no DOM.

import { AiError } from '../core/errors.js';
import { decodeImage } from '../core/image-input.js';
import { createSession, releaseSession } from '../core/ort-env.js';
import { parseDetConfig, parseRecConfig } from './config.js';
import { parseCharacterDict, ctcVocabulary, checkClasses } from './dict.js';
import { ocrPage } from './pipeline.js';

export const task = 'ocr';

/** Largest side, in pixels, the detector reads (its own limit). */
export const MAX_SIDE = 4000;

/**
 * The most pixels an image may have to be read (12000 × 12000): more than the
 * other tasks take, for large scans and posters (it is read at MAX_SIDE anyway),
 * and still a refusal (too-large) for a picture that would only exhaust memory.
 */
export const MAX_PIXELS = 12000 * 12000;

/** Below this mean score of a page's characters, its result says it was read with low confidence. */
export const LOW_CONFIDENCE = 0.8;

/** @param {import('../core/task-runtime.js').TaskContext} ctx */
export async function load(ctx) {
  const ort = await ctx.ort();
  if (ctx.test?.failLoad) await ort.InferenceSession.create(new Uint8Array([1, 2, 3, 4]));
  const [detBytes, recBytes, detYml, recYml] = await Promise.all([
    ctx.bytes('det:inference.onnx'), ctx.bytes('rec:inference.onnx'), ctx.text('det:inference.yml'), ctx.text('rec:inference.yml'),
  ]);
  const cfg = { det: parseDetConfig(detYml), rec: parseRecConfig(recYml) };
  const vocab = ctcVocabulary(parseCharacterDict(recYml));
  ctx.report('loading');
  // One after the other: a WebGPU device is set up once, by the first session.
  const det = await createSession(ort, detBytes, ctx.device);
  let rec;
  try {
    rec = await createSession(ort, recBytes, ctx.device);
  } catch (err) {
    await releaseSession(det);
    throw err;
  }
  const classes = rec.outputMetadata?.[0]?.shape?.at?.(-1);
  if (typeof classes === 'number') checkClasses(classes, vocab);
  return { ort, det, rec, cfg, vocab };
}

/**
 * @param {{ ort: any, det: any, rec: any, cfg: object, vocab: string[] }} state
 * @param {Blob|ImageBitmap|ImageData} input
 * @param {{ maxSide?: number, minScore?: number, orient?: boolean, test?: { failRun?: boolean } | null }} opts
 * @param {import('../core/task-runtime.js').TaskContext} ctx
 */
export async function run(state, input, opts = {}, ctx) {
  if (opts.test?.failRun) {
    const s = state.det;
    await s.run({ [s.inputNames[0]]: new state.ort.Tensor('float32', new Float32Array(3), [1, 3, 1, 1]) });
  }
  const maxSide = Math.min(MAX_SIDE, Math.max(32, Math.round(opts.maxSide || MAX_SIDE)));
  const minScore = opts.minScore == null ? 0.5 : Number(opts.minScore);
  if (!(minScore >= 0 && minScore <= 1)) throw new AiError('run-failed', 'minScore must be between 0 and 1');
  const img = await decodeImage(input, { maxSide, maxPixels: MAX_PIXELS });
  ctx.report('running');
  const scale = img.scaled ? img.sourceWidth / img.width : 1;
  const page = await ocrPage({ det: state.det, rec: state.rec, Tensor: state.ort.Tensor, cfg: state.cfg, vocab: state.vocab }, img, { minScore, scale, orient: opts.orient !== false });
  ctx.report('done');
  return {
    value: {
      text: page.text, lines: page.lines, width: img.sourceWidth, height: img.sourceHeight, device: ctx.device,
      orientation: page.orientation, lowConfidence: page.lines.length > 0 && page.meanScore < LOW_CONFIDENCE,
    },
    transfer: [],
  };
}

export async function dispose(state) {
  await releaseSession(state?.det);
  await releaseSession(state?.rec);
}
