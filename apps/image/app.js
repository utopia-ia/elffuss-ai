// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// image.elffuss.com: a description in, a picture out, made in this browser with
// SANA-Sprint on WebGPU. The page is a thin layer over the text-to-image task of
// the SDK (the same one other Elffuss apps call as a tool): it reads the form,
// shows each stage in the frame where the picture will appear, offers the PNG,
// another variation (a new seed) and the seed to repeat it, and keeps a history in
// this browser only. The first download waits for the primary button, which says
// its size; a browser that cannot run the model is told so before anything is
// downloaded.
import { createShell } from './shared/shell.js';
import { TextToImage, estimate, normalizeRequest, MAX_SEED, ASPECTS, canStartFromImage, sizeFromImage } from './sdk/text-to-image/index.js';
import { openHistory } from './history.js';

/** Longest side of the previews kept in the history. */
const THUMB_SIDE = 192;

const shell = await createShell();
const { t } = shell;
const $ = s => document.querySelector(s);
const prompt = $('textarea[data-input="prompt"]');
const seedInput = $('input[data-input="seed"]');
const frame = $('figure[data-role="frame"]');
const stageText = $('[data-role="frame-stage"]');
const cancel = $('main button[data-action="cancel"]');
const unsupported = $('[data-role="unsupported"]');
const historyBox = $('[data-role="history"]');
const historyList = $('[data-role="history-list"]');
const history = openHistory();
const fromBox = $('[data-role="from-image"]');
const chosenFig = $('[data-role="image-chosen"]');
const chosenImg = $('[data-role="image-thumb"]');
const chosenName = $('[data-role="image-name"]');
const strengthBox = $('[data-role="strength"]');
const strengthInput = $('input[data-input="strength"]');
const imageNote = $('[data-role="image-note"]');
// Test builds only: what the browser tests read back.
const probe = shell.config.testHooks ? (shell.diagnostics.image = { runs: 0, stages: [] }) : null;

let task = null; // the SDK task, created on the first run and kept for the next ones
let shown = null; // blob: URLs on screen
let blocked = false; // this browser cannot run the model
let source = null; // the picture to start from: { blob, url, name, width, height }

/** An element with attributes and children, built through the DOM (never from HTML text). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  node.append(...children.filter(c => c != null && c !== false));
  return node;
}

function button(action, text, onClick) {
  const b = el('button', { class: 'ghost', type: 'button', 'data-action': action }, text);
  b.addEventListener('click', async () => { try { await onClick(); } catch (err) { shell.showError(err); } });
  return b;
}

const checked = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || t('file.name');

/** The request of the form, checked; null (and a message) when it cannot be sent. */
function readForm() {
  const text = prompt.value.trim();
  if (!text) { shell.setStatus(t('error.empty-prompt')); prompt.focus(); return null; }
  const raw = seedInput.value.trim();
  if (raw && !(/^\d+$/.test(raw) && Number(raw) <= MAX_SEED)) { shell.setStatus(t('error.bad-seed')); seedInput.focus(); return null; }
  const seed = raw === '' ? undefined : Number(raw);
  if (source) {
    // the picture is read in the task (its pixels); here only the size and the strength are checked
    const size = sizeFromImage(source.width, source.height);
    normalizeRequest({ prompt: text, seed, ...size });
    return { prompt: text, seed, image: source.blob, strength: Number(strengthInput.value) / 100 };
  }
  return normalizeRequest({ prompt: text, aspect: checked('aspect'), steps: Number(checked('steps')), seed });
}

/** The named shape nearest to w × h (for the frame while the picture is made). */
function nearestAspect(w, h) {
  let best = '1:1', gap = Infinity;
  for (const [k, a] of Object.entries(ASPECTS)) { const d = Math.abs(Math.log(a.width / a.height) - Math.log(w / h)); if (d < gap) { gap = d; best = k; } }
  return best;
}

/** A picture to start from was chosen (or removed): show it, and let it set the shape. */
async function choose(file) {
  if (source) URL.revokeObjectURL(source.url);
  source = null;
  if (file) {
    try {
      const bmp = await createImageBitmap(file);
      source = { blob: file, url: URL.createObjectURL(file), name: file.name || t('file.name'), width: bmp.width, height: bmp.height };
      bmp.close();
    } catch { shell.setStatus(t('fromImage.bad')); }
  }
  chosenFig.hidden = !source; strengthBox.hidden = !source; imageNote.hidden = !source;
  if (source) { chosenImg.src = source.url; chosenImg.width = source.width; chosenImg.height = source.height; chosenName.textContent = source.name; }
  for (const r of document.querySelectorAll('input[name="aspect"], input[name="steps"]')) r.disabled = Boolean(source);
  syncFrame();
  if (probe) probe.source = source ? { width: source.width, height: source.height } : null;
}

/** The frame takes the chosen shape at once, so the picture lands where the eye already is. */
function syncFrame() { frame.dataset.aspect = source ? nearestAspect(source.width, source.height) : checked('aspect') || '1:1'; }

/** What the frame says while the model works. */
function showStage(p) {
  const key = p.status === 'running' && p.stage ? `stage.${p.stage}` : p.status === 'loading' ? 'stage.loading' : null;
  if (!key) return;
  const text = t(key, { step: p.step, steps: p.steps });
  stageText.textContent = text;
  frame.dataset.state = 'working';
  if (p.stage === 'step') frame.dataset.progress = String(Math.round((p.step / p.steps) * 100));
  if (probe) probe.stages.push(p.stage ? (p.step ? `${p.stage} ${p.step}/${p.steps}` : p.stage) : p.status);
}

const baseProgress = shell.onProgress;
shell.onProgress = p => { baseProgress(p); showStage(p); };

function forgetShown() {
  for (const u of shown || []) URL.revokeObjectURL(u);
  shown = null;
  shell.clearResult();
}

/** A small preview for the history (a canvas; the full picture is not kept). */
async function thumbOf(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    const k = THUMB_SIDE / Math.max(bmp.width, bmp.height);
    const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await c.convertToBlob({ type: 'image/webp', quality: 0.82 });
  } finally { bmp.close(); }
}

async function show(result) {
  forgetShown();
  const url = URL.createObjectURL(result.blob);
  shown = [url];
  const section = shell.showResult();
  const name = t('download.name', { name: slug(result.prompt), seed: result.seed });
  section.append(el('article', { class: 'card', 'data-role': 'image' },
    el('p', { class: 'actions' },
      button('download', t('action.download'), () => shell.download(result.blob, name)),
      button('variation', t('action.variation'), () => { seedInput.value = ''; shell.act(primary); }),
      button('keep-seed', t('action.keepSeed'), () => { seedInput.value = String(result.seed); seedInput.focus(); })),
    el('img', { src: url, alt: t('result.alt', { prompt: result.prompt }), width: result.width, height: result.height }),
    el('p', { class: 'muted', 'data-role': 'result-meta' }, t('result.meta', { width: result.width, height: result.height, seed: result.seed, steps: result.steps })),
    result.fromImage && el('p', { 'data-role': 'from-image-meta' }, t('fromImage.result', { name: source?.name || t('file.name'), pct: Math.round(result.strength * 100) })),
    result.truncated && el('p', { 'data-role': 'truncated' }, t('result.truncated'))));
  frame.hidden = true;
  section.querySelector('.actions')?.scrollIntoView?.({ block: 'nearest' });
  if (probe) Object.assign(probe, { runs: probe.runs + 1, result: { width: result.width, height: result.height, seed: result.seed, steps: result.steps, device: result.device, bytes: result.blob.size, fromImage: Boolean(result.fromImage), strength: result.strength ?? null } });
  try {
    await history.add({ prompt: result.prompt, seed: result.seed, steps: result.steps, aspect: result.aspect || '1:1', width: result.width, height: result.height, thumb: await thumbOf(result.blob) });
    await renderHistory();
  } catch { /* the history is a convenience */ }
}

async function renderHistory() {
  for (const img of historyList.querySelectorAll('img')) URL.revokeObjectURL(img.src);
  historyList.replaceChildren();
  const items = await history.list();
  historyBox.hidden = items.length === 0;
  for (const it of items) {
    const label = t('history.item', { prompt: it.prompt, seed: it.seed });
    const b = el('button', { class: 'ghost', type: 'button', 'data-action': 'restore', title: label, 'aria-label': label },
      el('img', { src: URL.createObjectURL(it.thumb), alt: '', width: it.width, height: it.height }));
    b.addEventListener('click', () => {
      prompt.value = it.prompt;
      seedInput.value = String(it.seed);
      for (const [name, v] of [['aspect', it.aspect], ['steps', String(it.steps)]]) {
        const input = document.querySelector(`input[name="${name}"][value="${v}"]`);
        if (input) input.checked = true;
      }
      syncFrame();
      prompt.focus();
    });
    historyList.append(el('li', {}, b));
  }
}

async function primary({ signal }) {
  const req = readForm();
  if (!req) return;
  forgetShown();
  syncFrame();
  frame.hidden = false;
  frame.dataset.state = 'working';
  delete frame.dataset.progress;
  stageText.textContent = t('status.checking');
  cancel.hidden = false;
  task ||= new TextToImage(shell.taskOptions({ device: 'webgpu' }));
  try {
    const result = await task.generate(req, { signal });
    await show(result);
    shell.setStatus('');
  } catch (err) {
    if (probe) probe.lastError = { code: err?.code, message: String(err?.message || err), cause: String(err?.cause?.message || '') };
    frame.dataset.state = 'idle';
    stageText.textContent = t('frame.idle');
    // A Worker lost to a cancel or a failure is replaced on the next run; the task stays.
    throw err;
  } finally {
    cancel.hidden = true;
  }
}

/** Before anything is downloaded: say so when this browser cannot run it. */
async function checkSupport() {
  try {
    const e = await estimate({ registry: shell.registry, model: shell.modelId, probe: shell.probe });
    if (!e.fits) {
      blocked = true;
      unsupported.textContent = t(`unsupported.${e.reason}`);
      unsupported.hidden = false;
      shell.setReady(false);
    }
  } catch { /* the run itself will say what is wrong */ }
}

for (const r of document.querySelectorAll('input[name="aspect"]')) r.addEventListener('change', syncFrame);
prompt.addEventListener('input', () => shell.setReady(!blocked && !shell.busy && prompt.value.trim().length > 0));
prompt.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !blocked) { e.preventDefault(); shell.act(primary); }
});
cancel.addEventListener('click', () => shell.cancel());
$('button[data-action="clear-history"]').addEventListener('click', async () => { await history.clear(); await renderHistory(); });
shell.onPrimary(primary, { after: () => shell.setReady(!blocked && prompt.value.trim().length > 0) });
// A picture to start from: offered when the model has the image encoder (drop, paste or choose).
if (canStartFromImage(shell.model)) {
  fromBox.hidden = false;
  shell.bindInput({ onFiles: files => { if (files[0]) choose(files[0]).catch(err => shell.showError(err)); }, paste: true, input: $('input[data-input="image"]') });
  $('button[data-action="remove-image"]').addEventListener('click', () => choose(null));
  if (probe) probe.fromImage = true;
}
shell.setReady(false);
syncFrame();
await checkSupport();
renderHistory().catch(() => {});
if (probe) probe.ready = true;
