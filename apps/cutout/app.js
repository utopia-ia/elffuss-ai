// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// cutout.elffuss.com: one image in (drop, pick or paste), the same image with
// its background made transparent out, as a PNG of the same size, with a
// before/after comparison and a download. The first time, choosing an image
// downloads nothing: the primary button does, and its label says what it will
// download and its size, then runs at once. Once the model is in this browser
// (or the button was pressed on this page), choosing an image runs it at once,
// with no click; one chosen while another runs is run right after.

import { createShell } from './shared/shell.js';
import { RemoveBg } from './sdk/remove-bg/index.js';
import { sniffImageType, DECODABLE, previewImage as smallCopy } from './sdk/core/image-input.js';
import { chooseVariant } from './sdk/core/device.js';
import { AiError } from './sdk/core/errors.js';
import { createCompare, PREVIEW_SIDE } from './compare.js';
import { outputName } from './names.js';

const shell = await createShell();
const { t } = shell;
const $ = sel => document.querySelector(sel);
const preview = $('[data-role="preview"]');
const previewImage = $('[data-role="preview-image"]');
const chosen = $('[data-role="chosen"]');
const cancelButton = $('[data-action="cancel"]');
const runner = shell.taskRunner(opts => new RemoveBg(opts));

/** @type {{ file: File, url: string, width: number, height: number } | null} */
let current = null;
/** @type {{ compare: { dispose(): void } } | null} */
let shown = null;
let runs = 0;
let picks = 0; // a later choice wins over one still being read

/** An element with attributes, text and children (no HTML strings anywhere). */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = String(v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  n.append(...children.filter(c => c != null));
  return n;
}

/** The error that keeps this browser from running the model at all (e.g. ?device=webgpu), or null. */
function blocker() {
  if (!shell.model) return new AiError('not-in-registry', 'this site has no model');
  try { chooseVariant(shell.model, shell.requested, shell.probe); return null; } catch (err) { return err; }
}

function setReady() {
  shell.setReady(Boolean(current) && !blocker() && !shell.busy);
}

function forgetResult() {
  shown?.compare.dispose();
  shown = null;
  shell.clearResult();
}

function forgetImage() {
  if (current) URL.revokeObjectURL(current.url);
  current = null;
  preview.hidden = true;
  previewImage.removeAttribute('src');
  chosen.textContent = '';
}

/** Take the first of the files as the image to work on. Nothing is downloaded here. */
async function choose(files) {
  if (!files.length) return;
  const pick = ++picks;
  const file = files[0];
  forgetResult();
  forgetImage();
  setReady();
  const type = sniffImageType(new Uint8Array(await file.slice(0, 32).arrayBuffer()));
  if (pick !== picks) return;
  if (!type || !DECODABLE.includes(type)) {
    shell.showError(new AiError('unsupported-format', 'not an image this site reads', { details: { type } }));
    return;
  }
  // A small copy to show (the full photo is never kept decoded on the page); a
  // picture over the pixel budget is refused here, before it is decoded.
  let small;
  try {
    small = await smallCopy(file, { maxSide: PREVIEW_SIDE });
  } catch (err) {
    if (pick !== picks) return;
    shell.showError(err);
    return;
  }
  if (pick !== picks) return;
  const url = URL.createObjectURL(small.blob);
  previewImage.src = url;
  try {
    await previewImage.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    if (pick !== picks) return;
    previewImage.removeAttribute('src');
    shell.showError(new AiError('decode-failed', 'the image could not be decoded', { cause: err }));
    return;
  }
  if (pick !== picks) { URL.revokeObjectURL(url); return; }
  current = { file, url, width: small.sourceWidth, height: small.sourceHeight };
  chosen.textContent = t('chosen', { name: file.name, width: current.width, height: current.height });
  preview.hidden = false;
  const blocked = blocker();
  if (blocked) shell.showError(blocked);
  else if (!shell.busy) shell.setStatus(files.length > 1 ? t('chosen.first', { count: files.length }) : t('chosen.ready'));
  setReady();
  await shell.inputReady({ blocked: Boolean(blocked) });
}

/** The result card: the comparison, what it ran on, and the download. */
async function show(job, result, device, fallback) {
  const name = outputName(job.file.name, t('download.suffix'));
  const canvas = el('canvas', { role: 'img', 'aria-label': t('compare.image') });
  const range = el('input', { type: 'range', min: 0, max: 100, step: 1, value: 50, 'data-input': 'compare' });
  const download = el('button', { class: 'ghost', type: 'button', 'data-action': 'download', text: t('action.download') });
  const notes = [];
  if (fallback) notes.push(t('fallback.wasm'));
  if (result.scaled) notes.push(t('result.scaled', { width: result.width, height: result.height }));
  if (result.coverage < 0.002) notes.push(t('result.empty'));
  const card = el('article', { class: 'card' },
    el('h3', { text: name }),
    el('p', { class: 'actions' }, download),
    el('figure', { class: 'stage' }, canvas),
    el('p', {}, el('label', {}, el('span', { text: t('compare.label') }), ' ', range)),
    el('p', { class: 'muted', 'data-role': 'facts', text: `${shell.deviceLabel(device)} · ${t('result.size', { width: result.width, height: result.height })}` }),
    ...notes.map(text => el('p', { 'data-role': 'note', text })),
  );
  const compare = await createCompare({ canvas, range, before: previewImage, after: result.png, width: result.width, height: result.height });
  shell.showResult().append(card);
  preview.hidden = true;
  shown = { compare };
  download.addEventListener('click', () => shell.download(result.png, name));
  download.scrollIntoView?.({ block: 'nearest' });
  if (shell.config.testHooks) {
    shell.diagnostics.cutout = { runs, name, width: result.width, height: result.height, device, fallback, scaled: result.scaled, coverage: result.coverage, bytes: result.png.size };
  }
}

shell.onPrimary(async ({ signal }) => {
  if (!current) { shell.setStatus(t('choose.first')); return; }
  const job = current;
  forgetResult();
  cancelButton.hidden = false;
  try {
    const { result, device, fallback } = await runner.run(job.file, { signal });
    runs++;
    if (job === current) await show(job, result, device, fallback);
  } finally {
    cancelButton.hidden = true;
  }
});

cancelButton.addEventListener('click', () => shell.cancel());
shell.bindInput({ onFiles: files => { choose(files).catch(err => shell.showError(err)); }, paste: true });
if (!shell.diagnostics.errors.length) shell.setStatus(t('choose.prompt'));
setReady();
