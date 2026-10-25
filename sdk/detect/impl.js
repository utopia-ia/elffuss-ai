// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Where the detector runs (a Worker, or the page with worker: false). The
// Transformers.js pipeline of the model, fed by the model store, gives its image
// processor and its ONNX model; the pipeline's own post-processing is not used
// (see decode.js). Each run decodes the image, resizes it once with a high-quality
// filter to the model's input, lets the processor turn it into a tensor, runs the
// model and decodes the boxes at the size of the image the caller gave. Never
// fetches, never touches the DOM.

import { decodeImage } from '../core/image-input.js';
import { AiError } from '../core/errors.js';
import { decodeDetections, labelList, logitShape, clampThreshold } from './decode.js';

export const task = 'detect';

/**
 * Longest side an image is decoded at before the resize to the model's input.
 * Larger photos are scaled down first, which keeps the memory of one run small.
 */
export const DECODE_MAX_SIDE = 1536;

/** The model's input size from its image processor (RF-DETR Nano: 384 × 384). */
export function inputSize(size) {
  const w = Number(size?.width), h = Number(size?.height);
  if (!(Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0)) {
    throw new AiError('model-mismatch', 'the image processor has no fixed input size', { details: { size } });
  }
  return { width: w, height: h };
}

export async function load(ctx) {
  const tf = await ctx.transformers();
  const pipe = await ctx.pipeline();
  if (ctx.test?.failLoad) throw new Error('test hook: the load fails after the pipeline exists');
  if (typeof pipe.processor !== 'function' || typeof pipe.model !== 'function') {
    throw new AiError('model-mismatch', 'the pipeline has no image processor or no model');
  }
  return {
    tf,
    pipe,
    size: inputSize(pipe.processor.image_processor?.size),
    id2label: pipe.model.config?.id2label || {},
    labels: null,
  };
}

/** RGBA pixels at the model's input size, resized with the browser's best filter. */
async function resized(img, { width, height }) {
  const source = new ImageData(img.data, img.width, img.height);
  const bmp = await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  try {
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, width, height).data;
  } finally {
    bmp.close();
  }
}

/**
 * The model's raw outputs for one decoded image (see decodeImage): `logits`
 * shaped [1, queries, classes] and `boxes` shaped [1, queries, 4]. The caller
 * disposes them.
 * @param {{ tf: any, pipe: any, size: { width: number, height: number } }} state what load() returned
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} img
 */
export async function forward(state, img) {
  const pixels = await resized(img, state.size);
  const raw = new state.tf.RawImage(pixels, state.size.width, state.size.height, 4);
  const { pixel_values: pixelValues } = await state.pipe.processor([raw]);
  try {
    const out = await state.pipe.model({ pixel_values: pixelValues });
    if (!out?.logits || !out?.pred_boxes) throw new AiError('model-mismatch', 'the model did not return logits and boxes');
    return { logits: out.logits, boxes: out.pred_boxes };
  } finally {
    try { pixelValues?.dispose?.(); } catch { /* released */ }
  }
}

/** The class names of a model with this many classes (cached in the state). */
function labelsFor(state, classes) {
  if (!state.labels || state.labels.length !== classes) state.labels = labelList(state.id2label, classes);
  return state.labels;
}

export async function run(state, input, opts = {}, ctx) {
  if (opts.test?.failRun) {
    // Test builds: an input of an impossible shape, inside the runtime.
    await state.pipe.model({ pixel_values: new state.tf.Tensor('float32', new Float32Array(3), [1, 3, 1, 1]) });
  }
  ctx.report('running');
  const threshold = clampThreshold(opts.threshold);
  const img = await decodeImage(input, { maxSide: DECODE_MAX_SIDE });
  const out = await forward(state, img);
  try {
    const labels = labelsFor(state, logitShape(out.logits.dims).classes);
    const objects = decodeDetections({ logits: out.logits, boxes: out.boxes, labels, threshold, width: img.sourceWidth, height: img.sourceHeight });
    ctx.report('done');
    return { value: { objects, width: img.sourceWidth, height: img.sourceHeight, device: ctx.device } };
  } finally {
    for (const x of [out.logits, out.boxes]) { try { x?.dispose?.(); } catch { /* released */ } }
  }
}

export async function dispose(state) {
  await state?.pipe?.dispose?.();
}
