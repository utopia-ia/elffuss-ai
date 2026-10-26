// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Where the detector runs (a Worker, or the page with worker: false). The
// Transformers.js pipeline of the model, fed by the model store, gives its image
// processor settings and its ONNX model; the pipeline's own pre- and
// post-processing are not used (see pixelValues below and decode.js). Each run
// decodes the image, resizes it once with a high-quality filter to the model's
// input, turns it into the tensor RF-DETR was trained on, runs the model and
// decodes the boxes at the size of the image the caller gave. Never fetches,
// never touches the DOM.
//
// The input. RF-DETR is trained on pixels scaled to 0-1 and then normalised with
// the ImageNet mean and deviation, the ones its preprocessor_config.json lists;
// but that file says do_normalize: false, so the image processor would hand the
// model x/255 only. Fed that way it finds noticeably fewer objects (on 200 COCO
// images, recall at score ≥ 0.5 and IoU ≥ 0.5 went from 0.727 to 0.649, with the
// same q8 file on a CPU). So the tensor is built here: rescaled and normalised
// with the file's own image_mean and image_std, whatever do_normalize says.

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
  const processor = pipe.processor.image_processor ?? pipe.processor;
  return {
    tf,
    pipe,
    size: inputSize(processor?.size),
    norm: normalisation(processor),
    id2label: pipe.model.config?.id2label || {},
    labels: null,
  };
}

/**
 * The normalisation the model takes, from its image processor: the rescale
 * factor and the mean and deviation of each channel. RF-DETR was trained with
 * them even though its config says do_normalize: false (see the top of the file).
 * @param {{ rescale_factor?: number, do_rescale?: boolean, image_mean?: number[], image_std?: number[] }} p
 * @returns {{ rescale: number, mean: number[], std: number[] }}
 */
export function normalisation(p) {
  const rescale = p?.do_rescale === false ? 1 : p?.rescale_factor ?? 1 / 255;
  const mean = p?.image_mean, std = p?.image_std;
  const three = (a, ok) => Array.isArray(a) && a.length === 3 && a.every(x => typeof x === 'number' && Number.isFinite(x) && ok(x));
  if (!(Number.isFinite(rescale) && rescale > 0) || !three(mean, () => true) || !three(std, x => x > 0)) {
    throw new AiError('model-mismatch', 'the image processor does not give a rescale factor and three channel means and deviations', { details: { rescale, mean, std } });
  }
  return { rescale, mean: [...mean], std: [...std] };
}

/**
 * The model input from RGBA pixels at its size: planar RGB (channels first),
 * (value · rescale − mean) / std. The alpha is not read.
 * @param {ArrayLike<number>} rgba width × height × 4 bytes
 * @param {{ width: number, height: number }} size
 * @param {{ rescale: number, mean: number[], std: number[] }} norm
 * @returns {Float32Array} 3 × height × width values
 */
export function pixelValues(rgba, { width, height }, { rescale, mean, std }) {
  const n = width * height;
  if (rgba.length !== n * 4) throw new RangeError(`RGBA ${width}×${height} needs ${n * 4} bytes, not ${rgba.length}`);
  const out = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const m = mean[c], s = std[c], plane = c * n;
    for (let i = 0; i < n; i++) out[plane + i] = (rgba[i * 4 + c] * rescale - m) / s;
  }
  return out;
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
  const { width, height } = state.size;
  const pixels = await resized(img, state.size);
  const input = new state.tf.Tensor('float32', pixelValues(pixels, state.size, state.norm), [1, 3, height, width]);
  try {
    const out = await state.pipe.model({ pixel_values: input });
    if (!out?.logits || !out?.pred_boxes) throw new AiError('model-mismatch', 'the model did not return logits and boxes');
    return { logits: out.logits, boxes: out.pred_boxes };
  } finally {
    try { input.dispose?.(); } catch { /* released */ }
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
