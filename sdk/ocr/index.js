// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// @elffuss/ai/ocr: read the text of an image, in the browser. PP-OCR (PaddleOCR,
// Apache-2.0) detection and recognition with ONNX Runtime Web, on WebGPU or
// WebAssembly; the model comes from the Elffuss model store at a pinned
// revision. Spanish and English, and every other language of its Latin and
// Chinese character list.
//
//   import { Ocr } from '@elffuss/ai/ocr';
//   const reader = new Ocr({ device: 'auto' });
//   const { text, lines } = await reader.run(file);
//   await reader.dispose();

import { Task, oneShot } from '../core/task.js';

/**
 * @typedef {{ xmin: number, ymin: number, xmax: number, ymax: number }} OcrBox
 *   Axis-aligned box of a line, in pixels of the input.
 * @typedef {{ text: string, score: number, box: OcrBox, polygon: number[][] }} OcrLine
 *   One line of text: what it says, the recogniser's mean confidence (0-1), its
 *   box, and its four corners (top-left, top-right, bottom-right, bottom-left).
 * @typedef {{ text: string, lines: OcrLine[], width: number, height: number, device: 'webgpu'|'wasm' }} OcrResult
 *   The page text (rows top to bottom, a row's lines joined with a space), the
 *   lines in reading order, the input's size and the backend that read it.
 * @typedef {{ signal?: AbortSignal, maxSide?: number, minScore?: number }} OcrRunOptions
 *   `maxSide` scales a larger input down before reading it (at most 4000, the
 *   detector's limit; boxes are still given in the input's pixels); `minScore`
 *   drops lines the recogniser is less sure of (0.5 by default).
 */

/**
 * Text reader. Loads the detector and the recogniser once (through the model
 * store), then reads one image per `run(input, options)`, one after another,
 * and returns an `OcrResult`. The input is a `Blob` or `File` (PNG, JPEG,
 * GIF, WebP, BMP or AVIF), an `ImageBitmap` or an `ImageData`.
 * @extends Task
 */
export class Ocr extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) {
    super({ task: 'ocr', workerUrl: new URL('./worker.js', import.meta.url), impl: () => import('./impl.js') }, options);
  }
}

/**
 * Read one image: load, run once, dispose. Options of the task (`device`,
 * `onProgress`, `signal`…) and of the run (`maxSide`, `minScore`) in one object.
 * @type {(input: Blob|ImageBitmap|ImageData, options?: import('../core/task.js').TaskOptions & OcrRunOptions) => Promise<OcrResult>}
 */
export const ocr = oneShot(Ocr);

export { normalizeText, characterErrorRate } from './order.js';
