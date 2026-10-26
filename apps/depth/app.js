// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// depth.elffuss.com: a photo in, its depth map out. The map is shown in colour
// (a ramp read from the page's CSS variables), turns in a 3D view drawn in
// software, and downloads as PNG in colour, in grey (lighter is nearer) and in
// 16-bit grey. The model runs in a Worker of this page and the photo never
// leaves the browser; nothing is downloaded before the primary button.
import { createShell, AiError } from './shared/shell.js';
import { Depth, colorizeDepth, encodeDepthPng16 } from './sdk/depth/index.js';
import { sniffImageType, DECODABLE, encodePng, previewImage, previewBitmap } from './sdk/core/image-input.js';
import { createView3d } from './view3d.js';
import { readRamp } from './colors.js';
import { VIEW, LIMITS } from './relief.js';

/** Longest side of the photo the map is computed at (the model itself works at about 518). */
const MAX_SIDE = 2048;
/** Longest side of the chosen photo as the page shows it (a small copy, never the full photo). */
const PREVIEW_SIDE = 1024;
/** Above this ratio of sides the model sees the photo with very few pixels across, and the map says little. */
const ELONGATED = 4;

const shell = await createShell();
const { t } = shell;
const runner = shell.taskRunner(o => new Depth(o));
const $ = s => document.querySelector(s);
const preview = $('main figure[data-role="preview"]');
const caption = $('main [data-role="preview-caption"]');
const cancel = $('main button[data-action="cancel"]');
// Test builds only: what the browser tests read back.
const probe = shell.config.testHooks ? (shell.diagnostics.depth = { runs: 0 }) : null;

let current = null; // the chosen photo: { file, name, url }
let shown = null; // the result on screen: { urls, view }
let picks = 0; // choices so far: a newer one wins over one still being read

/** An element with attributes and children, built through the DOM (never from HTML text). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  node.append(...children.filter(c => c != null && c !== false));
  return node;
}

function button(action, text, onClick) {
  const b = el('button', { class: 'ghost', type: 'button', 'data-action': action }, text);
  b.addEventListener('click', async () => {
    try { await onClick(); } catch (err) { shell.showError(err); }
  });
  return b;
}

const baseName = name => String(name || '').replace(/\.[^./\\]*$/, '').trim() || t('file.name');

/** Drop the result on screen: its 3D view, its blob: URLs, its cards. */
function forgetShown() {
  if (shown) {
    shown.view?.dispose();
    for (const u of shown.urls) URL.revokeObjectURL(u);
    shown = null;
  }
  shell.clearResult();
}

/**
 * A photo was picked, dropped or pasted: check its first bytes and its size,
 * show a small copy of it, enable the button. A photo over the pixel budget is
 * refused here, before anything decodes it.
 */
async function choose(file) {
  const pick = ++picks;
  forgetShown();
  if (current) URL.revokeObjectURL(current.url);
  current = null;
  preview.hidden = true;
  preview.querySelector('img')?.remove();
  caption.textContent = '';
  shell.setReady(false);
  let type = null;
  try { type = sniffImageType(new Uint8Array(await file.slice(0, 32).arrayBuffer())); } catch { type = null; }
  if (pick !== picks) return;
  if (!DECODABLE.includes(type)) {
    shell.showError(new AiError(file.size ? 'unsupported-format' : 'decode-failed', 'not an image this site reads', { details: { type } }));
    return;
  }
  let small;
  try { small = await previewImage(file, { maxSide: PREVIEW_SIDE }); }
  catch (err) { if (pick === picks) shell.showError(err); return; }
  if (pick !== picks) return;
  const url = URL.createObjectURL(small.blob);
  current = { file, name: baseName(file.name), url };
  const img = el('img', { src: url, alt: t('preview.alt', { name: file.name }), width: small.width, height: small.height });
  caption.textContent = t('preview.caption', { name: file.name, width: small.sourceWidth, height: small.sourceHeight });
  preview.prepend(img);
  preview.hidden = false;
  shell.setStatus('');
  shell.setReady(true);
}

/**
 * The photo's pixels at the map's size (with its EXIF orientation), for the 3D
 * view: from a copy scaled to the map, so the full photo is not kept decoded.
 */
async function textureOf(file, width, height) {
  const { bitmap } = await previewBitmap(file, { maxSide: Math.max(width, height) });
  try {
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}

async function show(chosen, result, device, fallback) {
  const { width, height } = result;
  const section = shell.showResult();
  const mine = { urls: [], view: null };
  shown = mine;
  // Another photo chosen meanwhile has already cleared this result.
  const stale = () => shown !== mine || current !== chosen;
  section.append(el('p', { 'data-role': 'result-meta' }, t('result.meta', { device: shell.deviceLabel(device), width, height })));
  if (fallback) section.append(el('p', { 'data-role': 'fallback' }, t('fallback.wasm')));
  if (result.scaled) section.append(el('p', { class: 'muted', 'data-role': 'scaled' }, t('result.scaled', { sourceWidth: result.sourceWidth, sourceHeight: result.sourceHeight, width, height })));
  if (Math.max(width, height) / Math.min(width, height) > ELONGATED) section.append(el('p', { 'data-role': 'elongated' }, t('result.elongated')));

  // The map in colour, along the ramp of the CSS variables (in grey if one is not a colour).
  const ramp = readRamp();
  const colour = ramp ? await encodePng({ width, height, data: colorizeDepth(result.depth, ramp) }) : null;
  if (stale()) return;
  const mapUrl = URL.createObjectURL(colour || result.png);
  mine.urls.push(mapUrl);
  const save = (blob, key) => shell.download(blob, t(key, { name: chosen.name }));
  section.append(el('article', { class: 'card', 'data-role': 'map' },
    el('h3', {}, t('map.title')),
    el('img', { src: mapUrl, alt: t('map.alt', { name: chosen.file.name }), width, height }),
    el('p', { class: 'muted' }, t('map.legend')),
    el('p', { class: 'actions' },
      colour && button('download-color', t('download.color'), () => save(colour, 'download.colorName')),
      button('download-grey', t('download.grey'), () => save(result.png, 'download.greyName')),
      button('download-16', t('download.png16'), async () => save(await encodeDepthPng16(result.depth, width, height), 'download.png16Name')))));

  // The 3D view: the photo in relief, turned by dragging or with the arrow keys.
  // A map of less than 2 × 2 has no surface to show.
  let texture = null;
  if (width >= 2 && height >= 2) {
    try { texture = await textureOf(chosen.file, width, height); } catch { texture = null; }
  }
  if (stale()) return;
  if (texture) {
    const canvas = el('canvas', { tabindex: 0, role: 'img', 'aria-label': t('view.label', { name: chosen.file.name }) });
    const relief = el('input', { type: 'range', min: Math.round(LIMITS.reliefMin * 100), max: Math.round(LIMITS.reliefMax * 100), step: 1, value: Math.round(VIEW.relief * 100), 'data-input': 'relief' });
    section.append(el('article', { class: 'card', 'data-role': 'view3d' },
      el('h3', {}, t('view.title')),
      canvas,
      el('p', { class: 'muted' }, t('view.hint')),
      el('p', { class: 'actions' },
        el('label', {}, t('view.relief') + ' ', relief),
        button('reset-view', t('view.reset'), () => shown?.view?.reset()))));
    const view = createView3d({ canvas, map: { depth: result.depth, width, height }, texture, onRender: s => { if (probe) probe.view = s; } });
    mine.view = view;
    relief.addEventListener('input', () => view.setView({ relief: Number(relief.value) / 100 }));
  }
  if (probe) Object.assign(probe, { runs: probe.runs + 1, width, height, device, dtype: result.dtype, fallback, scaled: result.scaled, colour: Boolean(colour), view3d: Boolean(texture) });
}

shell.bindInput({ onFiles: files => { if (files[0]) choose(files[0]); }, paste: true });
cancel.addEventListener('click', () => shell.cancel());
shell.onPrimary(async ({ signal }) => {
  if (!current) return;
  const chosen = current;
  forgetShown();
  cancel.hidden = false;
  try {
    const { result, device, fallback } = await runner.run(chosen.file, { signal, maxSide: MAX_SIDE });
    if (current === chosen) await show(chosen, result, device, fallback);
  } finally {
    cancel.hidden = true;
  }
});
shell.setReady(false);
