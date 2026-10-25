// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// detect.elffuss.com: the objects of a photo, or of the camera's live picture,
// with their boxes, names and scores. The model always runs at the confidence
// slider's lowest value, so moving the slider only filters what was found and
// never runs the model again. Built on the shared shell (shared/shell.js); the
// model runs in the SDK's Worker (sdk/detect/). The primary button is the only
// thing that downloads the model: the camera button opens the camera, and the
// primary button then detects on its picture, one frame after another, until
// the camera is stopped.

import { createShell } from './shared/shell.js';
import { Detect } from './sdk/detect/index.js';
import { openCamera, stopStream, cameraErrorKey, captureFrame } from './camera.js';
import { readPalette, drawOverlay, paint } from './overlay.js';
import { visible, percent, formatThreshold, className, roundBox, normalizeBox, resultJson, downloadName } from './view.js';

const shell = await createShell();
const { t, lang } = shell;
const $ = sel => document.querySelector(sel);
const el = {
  camera: $('main [data-action="camera"]'),
  stop: $('main [data-action="stop"]'),
  threshold: $('main [data-input="threshold"]'),
  thresholdValue: $('main [data-role="threshold-value"]'),
  image: $('main [data-role="image"]'),
  video: $('main [data-role="video"]'),
  frame: $('main [data-role="frame"]'),
  overlay: $('main [data-role="overlay"]'),
  summary: $('main [data-role="summary"]'),
  note: $('main [data-role="note"]'),
  objects: $('main [data-role="objects"]'),
  json: $('main [data-action="download-json"]'),
  png: $('main [data-action="download-png"]'),
};

/** Spanish class names (the model's are English); null in English or if they cannot be read. */
async function loadNames() {
  if (lang !== 'es') return null;
  try { return await (await fetch(new URL('./labels.es.json', import.meta.url), { credentials: 'same-origin' })).json(); }
  catch { return null; }
}
let names = null; // filled in without holding up the page; English names until then
const runAt = Number(el.threshold.min) || 0.3;

const state = {
  mode: 'none',     // 'image' | 'camera'
  file: null,       // the chosen File
  imageUrl: null,   // its object URL, shown on the stage
  opening: false,   // the camera is being asked for (one request at a time)
  picks: 0,         // how many images were chosen (one chosen while asking wins over the camera)
  stream: null,     // the camera, while it is open
  tracks: [],       // the tracks of the last camera (they end when it stops)
  live: false,      // frames are being analysed
  last: null,       // { result, device, fallback, kind: 'image'|'frame', source }
};

// Test builds only: what the browser tests read.
const hooks = shell.config.testHooks && globalThis.__elffuss
  ? (globalThis.__elffuss.detect = { runs: 0, frames: [], last: null, tracks: () => state.tracks.map(x => x.readyState) })
  : null;

const runner = shell.taskRunner(o => new Detect({ ...o, onProgress }));

/**
 * Progress of the task. A load is always followed by a run here, so "ready"
 * reads as "working"; the end of a run is said by the page itself (the Worker's
 * per-run statuses do not reach it). During the live loop the per-frame
 * statuses stay quiet.
 */
function onProgress(p) {
  if (p.status === 'running' || p.status === 'done') return;
  shell.onProgress(p); // shows or hides the progress bar, and says the status
  if (p.status === 'ready') shell.setStatus(t(state.live ? 'camera.live' : 'status.running'));
}

const threshold = () => Number(el.threshold.value);
const nameOf = label => className(label, lang, names);
const scoreText = n => t('object.score', { n });

function showThreshold() {
  el.thresholdValue.textContent = formatThreshold(threshold(), lang);
}

function clearOverlay() {
  el.overlay.getContext('2d').clearRect(0, 0, el.overlay.width, el.overlay.height);
}

function objectItem(o) {
  const li = document.createElement('li');
  li.dataset.label = o.label;
  const what = document.createElement('span');
  what.textContent = `${nameOf(o.label)} · ${scoreText(percent(o.score))}`;
  const where = document.createElement('span');
  where.className = 'muted';
  where.textContent = ` · ${t('object.box', roundBox(o.box))}`;
  li.append(what, where);
  return li;
}

/** Draw the last result at the slider's threshold: boxes, summary, list. */
function render() {
  const last = state.last;
  const shown = last ? visible(last.result.objects, threshold()) : [];
  if (last) {
    const displayWidth = el.overlay.getBoundingClientRect().width || last.result.width;
    drawOverlay(el.overlay, { width: last.result.width, height: last.result.height, objects: shown, name: nameOf, score: scoreText, palette: readPalette(), displayWidth });
  } else clearOverlay();
  el.summary.textContent = last ? `${shown.length === 1 ? t('result.one') : t('result.many', { n: shown.length })} · ${shell.deviceLabel(last.device)}` : '';
  el.note.hidden = !last?.fallback;
  el.note.textContent = last?.fallback ? t('fallback.wasm') : '';
  const items = shown.map(objectItem);
  if (last && !items.length) {
    const li = document.createElement('li');
    li.textContent = t('result.none');
    items.push(li);
  }
  el.objects.replaceChildren(...items);
  el.json.hidden = el.png.hidden = !last;
  if (hooks) hooks.last = last && { kind: last.kind, device: last.device, fallback: last.fallback, width: last.result.width, height: last.result.height, objects: last.result.objects, shown: shown.map(o => o.label), threshold: threshold() };
}

// ── a photo ──────────────────────────────────────────────────────────────────
function chooseFile(file) {
  if (!file) return;
  stopCamera({ keepFrame: false });
  state.picks++;
  state.mode = 'image';
  state.file = file;
  state.last = null;
  if (state.imageUrl) URL.revokeObjectURL(state.imageUrl);
  state.imageUrl = URL.createObjectURL(file);
  el.image.src = state.imageUrl;
  el.image.hidden = false;
  el.video.hidden = true;
  el.frame.hidden = true;
  render();
  shell.showResult();
  shell.setStatus(t('file.chosen', { name: file.name }));
  shell.setReady(true);
}

async function detectFile(signal) {
  const file = state.file;
  shell.setStatus(t('status.running'));
  const { result, device, fallback } = await runner.run(file, { signal, threshold: runAt });
  if (hooks) hooks.runs++;
  if (state.file !== file || state.mode !== 'image') return; // another input was chosen meanwhile
  state.last = { result, device, fallback, kind: 'image', source: file.name };
  render();
  shell.setStatus(t('status.done'));
}

// ── the camera ───────────────────────────────────────────────────────────────
async function startCamera() {
  if (state.stream || state.opening || shell.busy) return;
  state.opening = true;
  try { await showCamera(); } finally { state.opening = false; }
}

/** Open the camera and show its picture on the stage. */
async function showCamera() {
  shell.setStatus(t('camera.asking'));
  const picks = state.picks;
  let stream;
  try { stream = await openCamera(navigator.mediaDevices); }
  catch (err) { if (state.picks === picks) shell.setStatus(t(cameraErrorKey(err))); return; }
  if (state.picks !== picks) { stopStream(stream); return; } // an image was chosen meanwhile
  state.mode = 'camera';
  state.stream = stream;
  state.tracks = stream.getTracks();
  state.file = null;
  state.last = null;
  if (state.imageUrl) { URL.revokeObjectURL(state.imageUrl); state.imageUrl = null; el.image.removeAttribute('src'); }
  el.image.hidden = true;
  el.frame.hidden = true;
  // Shown before it plays: a hidden video that is asked to play may stay paused.
  el.video.hidden = false;
  shell.showResult();
  render();
  el.video.srcObject = stream;
  try { await el.video.play(); }
  catch (err) { stopCamera({ keepFrame: false }); shell.setStatus(t(cameraErrorKey(err))); return; }
  el.camera.hidden = true;
  el.stop.hidden = false;
  shell.setReady(true);
  shell.setStatus(t('camera.ready'));
}

/**
 * Keep the last analysed frame (it is in the frame canvas) on the stage once the
 * camera is closed; with nothing analysed, there is no result to show.
 */
function freeze() {
  const kept = state.last?.kind === 'frame';
  el.frame.hidden = !kept;
  if (!kept && shell.els.result) shell.els.result.hidden = true;
  render();
}

function stopCamera({ keepFrame }) {
  state.live = false;
  if (!state.stream) return;
  stopStream(state.stream);
  state.stream = null;
  el.video.srcObject = null;
  el.video.hidden = true;
  el.camera.hidden = false;
  el.stop.hidden = true;
  if (keepFrame) {
    freeze();
    shell.setStatus(t('camera.stopped'));
  }
  shell.setReady(Boolean(state.file));
}

const pause = ms => new Promise(r => setTimeout(r, ms));

/** Analyse the camera's picture one frame after another, until the camera stops. */
async function detectLive(signal) {
  state.live = true;
  shell.setStatus(t('camera.live'));
  try {
    while (state.live && state.stream && !signal.aborted) {
      if (!captureFrame(el.video, el.frame)) { await pause(40); continue; }
      const out = await runner.run(el.frame, { signal, threshold: runAt });
      if (hooks) hooks.runs++;
      if (state.mode !== 'camera') break;
      state.last = { ...out, kind: 'frame', source: t('download.camera') };
      if (hooks) {
        const { width, height, objects } = out.result;
        hooks.frames.push({ width, height, device: out.device, objects: objects.map(o => ({ label: o.label, score: o.score, box: normalizeBox(o.box, width, height) })) });
        if (hooks.frames.length > 30) hooks.frames.shift();
      }
      if (state.stream) { render(); shell.setStatus(t('camera.live')); } else freeze();
    }
  } finally {
    state.live = false;
  }
}

// ── downloads ────────────────────────────────────────────────────────────────
function downloadJson() {
  const last = state.last;
  if (!last) return;
  const text = resultJson({ source: last.source, model: shell.modelId, device: last.device, threshold: threshold(), result: last.result });
  shell.download(new Blob([text], { type: 'application/json' }), downloadName(last.source, t('download.objects'), 'json'));
}

async function downloadPng() {
  const last = state.last;
  if (!last) return;
  const { width, height } = last.result;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  g.drawImage(last.kind === 'frame' ? el.frame : el.image, 0, 0, width, height);
  paint(g, { width, height, objects: visible(last.result.objects, threshold()), name: nameOf, score: scoreText, palette: readPalette() });
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (blob) shell.download(blob, downloadName(last.source, t('download.boxes'), 'png'));
}

// ── wiring ───────────────────────────────────────────────────────────────────
shell.bindInput({ paste: true, onFiles: files => chooseFile(files[0]) });
el.camera.addEventListener('click', () => { startCamera(); });
el.stop.addEventListener('click', () => stopCamera({ keepFrame: true }));
el.threshold.addEventListener('input', () => { showThreshold(); render(); });
el.json.addEventListener('click', downloadJson);
el.png.addEventListener('click', () => { downloadPng(); });
addEventListener('pagehide', () => stopCamera({ keepFrame: false }));
// The labels keep a readable size when the picture is shown at another size.
let resizing = 0;
addEventListener('resize', () => { cancelAnimationFrame(resizing); resizing = requestAnimationFrame(() => { if (state.last && !state.live) render(); }); });

shell.onPrimary(async ({ signal }) => {
  if (state.stream) return detectLive(signal);
  if (state.mode === 'image' && state.file) return detectFile(signal);
  shell.setStatus(t('pick.first'));
});

showThreshold();
shell.setReady(false);
if (!shell.diagnostics.errors.length) shell.setStatus(t('pick.first'));
loadNames().then(n => { names = n; if (state.last) render(); });
// Every control is wired: a hook for scripts (and the browser tests), not for styling.
document.documentElement.dataset.app = 'ready';
