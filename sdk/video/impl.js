// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The image-to-video task where the models run (a Worker, or the page with
// worker: false). A run turns a photo into its scene (depth with Depth Anything
// V2 Small, layers cut where the depth jumps, the background behind them painted
// by MI-GAN) and the scene into a video: the camera of camera.js, drawn with
// WebGL2 on an OffscreenCanvas (render.js) and encoded with WebCodecs
// (encode.js). The scene of the last photo is kept, so another move, length or
// format of the same photo goes straight to the drawing. dispose() releases the
// sessions and the drawing context.

import { AiError, toAiError } from '../core/errors.js';
import { decodeImage } from '../core/image-input.js';
import { releaseSession } from '../core/ort-env.js';
import { planCamera, cameraAt, frameCount, frameTime, RELIEF } from './camera.js';
import { normalizeOptions, outputSize } from './options.js';
import { normalizeDisparity, resizePlane, guidedFilter, toGray, planLayers, morph, fillBehind, extendOutward, softAlpha, decontaminate, borderSamples, boxMean, revealRegion } from './layers.js';
import { cropFor, modelInputs, composite } from './inpaint.js';
import { depthInputSize, depthSpec, toDepthInput } from './depth.js';
import { createRenderer } from './render.js';
import { encodeVideo } from './encode.js';
import { fitSoundtrack } from './audio.js';

export const task = 'image-to-video';

/** Longest side of the photo kept for each quality (the frames are cut from it). */
export const PHOTO_SIDE = Object.freeze({ high: 2560, standard: 1664 });
/** Longest side the depth and the layers are worked out at. */
export const PLAN_SIDE = 768;
/** Longest side of the scene the page gets for its preview, by default. */
export const PREVIEW_SIDE = 1280;

export async function load(ctx) {
  const ort = await ctx.ort();
  const depthFile = ctx.files.find(f => f.part === 'depth' && f.path.endsWith('.onnx'));
  const inpaintFile = ctx.files.find(f => f.part === 'inpaint' && f.path.endsWith('.onnx'));
  if (!depthFile || !inpaintFile) throw new AiError('model-mismatch', 'this variant lacks the depth or the inpainting model');
  const spec = depthSpec(JSON.parse(await ctx.text('depth:preprocessor_config.json')));
  const depth = await ctx.session(depthFile.ref);
  if (ctx.test?.failLoad) { await releaseSession(depth); throw new AiError('run-failed', 'test hook: the load fails after the sessions exist'); }
  let inpaint, inpaintDevice = ctx.device;
  try { inpaint = await ctx.session(inpaintFile.ref); }
  catch (err) {
    if (ctx.device !== 'webgpu') throw err;
    inpaint = await ctx.session(inpaintFile.ref, { providers: ['wasm'] });
    inpaintDevice = 'wasm';
  }
  return { ort, depth, inpaint, spec, inpaintDevice, scene: null };
}

/** A content key of an input: equal photos get equal keys. */
async function keyOf(input, side) {
  if (typeof Blob !== 'undefined' && input instanceof Blob && globalThis.crypto?.subtle) {
    const h = await crypto.subtle.digest('SHA-256', await input.arrayBuffer());
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('') + ':' + side;
  }
  return null;
}

/** RGBA pixels scaled with the browser's own high-quality resampling. */
function scaleRgba(data, W, H, w, h) {
  if (w === W && h === H) return data;
  const a = new OffscreenCanvas(W, H);
  a.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), W, H), 0, 0);
  const b = new OffscreenCanvas(w, h);
  const g = b.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(a, 0, 0, w, h);
  return g.getImageData(0, 0, w, h).data;
}

const fitSide = (W, H, side) => { const k = Math.min(1, side / Math.max(W, H)); return [Math.max(2, Math.round(W * k)), Math.max(2, Math.round(H * k))]; };

/** Premultiply RGBA in place. */
function premultiply(px) {
  for (let i = 0; i < px.length; i += 4) { const a = px[i + 3] / 255; px[i] = Math.round(px[i] * a); px[i + 1] = Math.round(px[i + 1] * a); px[i + 2] = Math.round(px[i + 2] * a); }
  return px;
}

/** A mask at another size (nearest pixel). */
function scaleMask(m, w, h, W, H) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / H)); for (let x = 0; x < W; x++) out[y * W + x] = m[sy * w + Math.min(w - 1, Math.floor((x + 0.5) * w / W))]; }
  return out;
}

/**
 * The photo with `region` (photo size) painted by MI-GAN, which sees the photo
 * without `hole` (all of what is near, so that none of it leaks into the painting).
 */
async function paint(state, rgba, W, H, hole, region = hole) {
  const crop = cropFor(hole, W, H);
  if (!crop) return rgba;
  const { image, mask } = modelInputs(rgba, hole, W, crop);
  const { ort } = state;
  const out = await state.inpaint.run({
    [state.inpaint.inputNames[0]]: new ort.Tensor('uint8', image, [1, 3, crop.oh, crop.ow]),
    [state.inpaint.inputNames[1]]: new ort.Tensor('uint8', mask, [1, 1, crop.oh, crop.ow]),
  });
  const t = out[state.inpaint.outputNames[0]];
  if (t?.dims?.[2] !== crop.oh || t?.dims?.[3] !== crop.ow) throw new AiError('model-mismatch', `the inpainting model gave ${t?.dims?.join('×')}`);
  const painted = t.data;
  // A soft seam: the hole fully, fading out over a few pixels around it.
  const f = new Float32Array(W * H);
  for (let i = 0; i < f.length; i++) f[i] = region[i];
  const r = Math.max(2, Math.round(Math.max(W, H) / 600));
  const soft = boxMean(f, W, H, r);
  for (let i = 0; i < soft.length; i++) soft[i] = region[i] ? 1 : hole[i] ? Math.min(1, soft[i] * 2) : 0;
  return composite(rgba, W, H, crop, painted, soft);
}

/** The subject when no near part stands out: the middle of the photo, at its median depth there. */
function centreFocus(d, w, h) {
  const ds = [];
  for (let y = Math.floor(h * 0.3); y < Math.ceil(h * 0.7); y++) for (let x = Math.floor(w * 0.3); x < Math.ceil(w * 0.7); x++) ds.push(d[y * w + x]);
  ds.sort((a, b) => a - b);
  return { u: 0.5, v: 0.5, d: ds[Math.floor(ds.length / 2)] ?? 0.5 };
}

/** Depth behind what is near: filled from around `hole`, but only where `region` says it can show. */
function behind(d, hole, region, w, h) {
  const filled = fillBehind(d, hole, w, h);
  const out = Float32Array.from(d);
  for (let i = 0; i < out.length; i++) if (region[i]) out[i] = filled[i];
  return out;
}

/**
 * The scene of a photo: its layers far to near, their depth, the subject, and
 * the edge points the framing keeps out of the frame.
 */
async function buildScene(state, input, side, ctx) {
  const img = await decodeImage(input, { maxSide: side });
  const W = img.width, H = img.height, rgba = img.data;
  ctx.report('running', { stage: 'depth' });
  // Depth: the model's input as its preprocessor says, its answer back to the plan size.
  const [dw, dh] = depthInputSize(W, H, state.spec);
  const din = toDepthInput(scaleRgba(rgba, W, H, dw, dh), dw, dh, state.spec);
  const { ort } = state;
  const out = await state.depth.run({ [state.depth.inputNames[0]]: new ort.Tensor('float32', din, [1, 3, dh, dw]) });
  const pred = out[state.depth.outputNames[0]];
  const ph = pred.dims.at(-2), pw = pred.dims.at(-1);
  const [aw, ah] = fitSide(W, H, PLAN_SIDE);
  const planRgba = scaleRgba(rgba, W, H, aw, ah);
  const gray = toGray(planRgba, aw, ah);
  const raw = resizePlane(normalizeDisparity(pred.data), pw, ph, aw, ah);
  const d = Float32Array.from(guidedFilter(gray, raw, aw, ah, 3, 4e-3), v => Math.min(1, Math.max(0, v)));
  for (const t of Object.values(out)) t?.dispose?.();

  // Layers: cut where the depth jumps (one cut by default), far to near.
  const { cuts } = planLayers(d, aw, ah);
  const grow = Math.max(3, Math.round(PLAN_SIDE / 70));
  const texGray = toGray(rgba, W, H);
  const layers = [];
  const borders = [];
  let focus = null;
  if (!cuts.length) {
    layers.push({ rgba: Uint8ClampedArray.from(rgba), width: W, height: H, depth: { data: d, width: aw, height: ah }, opaque: true });
    borders.push(borderSamples({ depth: d, dw: aw, dh: ah }));
    focus = centreFocus(d, aw, ah);
  } else {
    ctx.report('running', { stage: 'inpaint' });
    const union = new Uint8Array(aw * ah);
    for (const c of cuts) for (let i = 0; i < union.length; i++) union[i] |= c.mask[i];
    const all = revealRegion(union, d, aw, ah, { grow });
    const farRgba = await paint(state, rgba, W, H, scaleMask(all.hide, aw, ah, W, H));
    const farDepth = behind(d, all.hide, all.hide, aw, ah);
    layers.push({ rgba: farRgba, width: W, height: H, depth: { data: farDepth, width: aw, height: ah }, opaque: true });
    borders.push(borderSamples({ depth: farDepth, dw: aw, dh: ah }));
    for (let k = 0; k < cuts.length; k++) {
      const c = cuts[k];
      // What is nearer than this cut is painted over in this layer's colours and depth.
      const nearer = new Uint8Array(aw * ah);
      for (let j = k + 1; j < cuts.length; j++) for (let i = 0; i < nearer.length; i++) nearer[i] |= cuts[j].mask[i];
      const hasNearer = nearer.some(Boolean);
      const near = hasNearer ? revealRegion(nearer, d, aw, ah, { grow }) : null;
      const base = hasNearer ? await paint(state, rgba, W, H, scaleMask(near.hide, aw, ah, W, H)) : rgba;
      const dl = hasNearer ? behind(d, near.hide, near.hide, aw, ah) : d;
      const alpha = softAlpha(c.mask, aw, ah, texGray, W, H);
      const real = revealRegion(c.mask, d, aw, ah, { grow: grow * 2 }).hide;
      const px = premultiply(decontaminate(base, alpha, W, H, 0.92, scaleMask(real, aw, ah, W, H)));
      const depth = extendOutward(dl, c.mask, aw, ah, Math.max(2, Math.round(grow / 2)));
      layers.push({ rgba: px, width: W, height: H, depth: { data: depth, width: aw, height: ah }, opaque: false });
      borders.push(borderSamples({ alpha: c.mask, aw, ah, depth, dw: aw, dh: ah }));
    }
    // The subject: the nearest cut, where it is solid.
    const m = cuts.at(-1).mask;
    let sx = 0, sy = 0, n = 0;
    const ds = [];
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) if (m[y * aw + x]) { sx += x; sy += y; n++; ds.push(d[y * aw + x]); }
    ds.sort((a, b) => a - b);
    focus = { u: (sx / n + 0.5) / aw, v: (sy / n + 0.5) / ah, d: ds[Math.floor(ds.length / 2)] };
    // What is near but off to a side (a shoulder at the edge of the frame) is not the
    // subject: then the camera holds what is in the middle of the photo.
    if (Math.hypot(focus.u - 0.5, focus.v - 0.5) > 0.3) focus = centreFocus(d, aw, ah);
  }
  return { A: W / H, width: W, height: H, relief: RELIEF, focusD: focus.d, focus, layers, borders, cuts: cuts.length };
}

/** A copy of a scene for the page's preview: smaller textures, buffers it may keep. */
function sceneForPage(scene, side) {
  const [w, h] = fitSide(scene.width, scene.height, side);
  const layers = scene.layers.map(l => ({ rgba: Uint8ClampedArray.from(scaleRgba(l.rgba, l.width, l.height, w, h)), width: w, height: h, opaque: l.opaque,
    depth: { data: Float32Array.from(l.depth.data), width: l.depth.width, height: l.depth.height } }));
  const value = { A: scene.A, width: w, height: h, relief: scene.relief, focusD: scene.focusD, focus: scene.focus, borders: scene.borders, layers, cuts: scene.cuts };
  return { value, transfer: layers.flatMap(l => [l.rgba.buffer, l.depth.data.buffer]) };
}

/**
 * Run: `opts.output` 'scene' gives the scene (for a page's live preview), else
 * the video (see index.js, Video.run).
 */
export async function run(state, input, opts = {}, ctx) {
  if (opts.test?.failRun) {
    await state.depth.run({ [state.depth.inputNames[0]]: new state.ort.Tensor('float32', new Float32Array(3), [1, 3, 1, 1]) });
  }
  const o = normalizeOptions(opts);
  const side = PHOTO_SIDE[o.quality];
  const key = await keyOf(input, side);
  let scene = key && state.scene?.key === key ? state.scene : null;
  try {
    if (!scene) {
      state.scene = null;
      scene = await buildScene(state, input, side, ctx);
      scene.key = key;
      state.scene = key ? scene : null;
    }
    if (opts.output === 'scene') {
      ctx.report('done');
      return sceneForPage(scene, Number(opts.previewSide) > 0 ? Math.min(side, Number(opts.previewSide)) : PREVIEW_SIDE);
    }
    const { width, height } = outputSize(o.aspect, o.quality);
    const canvas = new OffscreenCanvas(width, height);
    const renderer = createRenderer(canvas, { msaa: 4, grid: o.quality === 'high' ? 560 : 400, preserve: true });
    let result;
    try {
      renderer.setScene(scene);
      const plan = planCamera({ preset: o.preset, aspect: width / height, A: scene.A, focus: scene.focus, relief: scene.relief, strength: o.strength, borders: scene.borders });
      const n = frameCount(o.seconds, o.fps);
      const audio = opts.audio && opts.audio.channels?.length ? fitSoundtrack(opts.audio, n / o.fps) : null;
      ctx.report('running', { stage: 'render', frame: 0, frames: n });
      result = await encodeVideo({
        width, height, fps: o.fps, frames: n, audio, container: o.container,
        frame: i => { renderer.draw(cameraAt(plan, frameTime(i, n, plan.loop)), { ...o.effects, seed: (i * 0.6180339) % 1 }); return canvas; },
        onProgress: p => ctx.report('running', p),
      });
    } finally {
      renderer.dispose();
    }
    ctx.report('done');
    return {
      value: { ...result, model: ctx.modelId, device: ctx.device, dtype: ctx.dtype, preset: o.preset, aspect: o.aspect, layers: scene.layers.length },
      transfer: [],
    };
  } catch (err) {
    throw toAiError(err, 'run-failed');
  }
}

export async function dispose(state) {
  if (!state) return;
  state.scene = null;
  await releaseSession(state.depth);
  await releaseSession(state.inpaint);
}
