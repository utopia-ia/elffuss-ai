// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Test page of the text-to-video mode (served by tests/browser/video-gen-serve.mjs):
// the device check first (estimate), the exact download on the button, progress
// by stage, cancel, the video in a player and as a file, an optional soundtrack.
// It reads the model files from the local weight cache through a stand-in for the
// model store, and the registry (registry/tasks.json). The site's own page is the
// text mode of video.elffuss.com (apps/video); this one runs without the store.
import { TextToVideo, estimate, SIZES, SECONDS, STEPS } from '../../../sdk/video-gen/index.js';
import { decodeSoundtrack } from '../../../sdk/video/audio.js';

const STRINGS = {
  es: {
    title: 'Vídeo desde texto (avanzado)',
    intro: 'Escribe lo que quieres ver y el modelo Wan 2.1 lo genera en tu navegador, con la tarjeta gráfica. Nada sale de tu equipo.',
    prompt: 'Descripción', size: 'Tamaño', seconds: 'Segundos', steps: 'Pasos', seed: 'Semilla (opcional)', sound: 'Música (opcional)',
    cancel: 'Cancelar', download: 'Descargar MP4',
    run: 'Generar vídeo', downloadAndRun: 'Descargar el modelo ({size}) y generar',
    model: 'Modelo: {name}, {size} la primera vez. Se guarda en este navegador.',
    checking: 'Comprobando este dispositivo…',
    'stage.download': 'Descargando el modelo: {loaded} de {total}',
    'stage.encode': 'Leyendo la descripción ({n} de {count})', 'stage.load': 'Preparando el modelo de vídeo',
    'stage.step': 'Generando: paso {n} de {count}', 'stage.decode': 'Pintando los fotogramas ({n} de {count})', 'stage.mux': 'Guardando el MP4',
    done: 'Hecho en {time}.', meta: '{width} × {height}, {seconds} s, {fps} fps, semilla {seed}',
    cancelled: 'Cancelado.',
    'reason.no-webgpu': 'Este navegador no tiene WebGPU: el modo avanzado no está disponible.',
    'reason.no-adapter': 'No hay una tarjeta gráfica disponible para WebGPU.',
    'reason.software-adapter': 'La tarjeta gráfica es por software: sería demasiado lento.',
    'reason.no-shader-f16': 'La tarjeta gráfica no admite media precisión (shader-f16), que el modelo necesita.',
    'reason.buffers-too-small': 'La tarjeta gráfica no admite búferes tan grandes como necesita este tamaño. Prueba uno menor o menos segundos.',
    'reason.not-enough-memory': 'No hay memoria gráfica suficiente ({memory}) para este tamaño. Prueba uno menor o menos segundos.',
    'reason.no-webgpu-variant': 'Este modelo no tiene versión para WebGPU.',
    fits: 'Este dispositivo puede generarlo (necesita unos {memory} de memoria gráfica).',
    error: 'No se pudo generar: {message}',
  },
  en: {
    title: 'Video from text (advanced)',
    intro: 'Describe what you want to see and the Wan 2.1 model makes it in your browser, on your graphics card. Nothing leaves your device.',
    prompt: 'Description', size: 'Size', seconds: 'Seconds', steps: 'Steps', seed: 'Seed (optional)', sound: 'Music (optional)',
    cancel: 'Cancel', download: 'Download MP4',
    run: 'Make video', downloadAndRun: 'Download the model ({size}) and make the video',
    model: 'Model: {name}, {size} the first time. It is kept in this browser.',
    checking: 'Checking this device…',
    'stage.download': 'Downloading the model: {loaded} of {total}',
    'stage.encode': 'Reading the description ({n} of {count})', 'stage.load': 'Preparing the video model',
    'stage.step': 'Generating: step {n} of {count}', 'stage.decode': 'Painting the frames ({n} of {count})', 'stage.mux': 'Saving the MP4',
    done: 'Done in {time}.', meta: '{width} × {height}, {seconds} s, {fps} fps, seed {seed}',
    cancelled: 'Cancelled.',
    'reason.no-webgpu': 'This browser has no WebGPU: the advanced mode is not available.',
    'reason.no-adapter': 'No graphics card is available to WebGPU.',
    'reason.software-adapter': 'The graphics adapter is software: it would be far too slow.',
    'reason.no-shader-f16': 'The graphics card has no half precision (shader-f16), which the model needs.',
    'reason.buffers-too-small': 'The graphics card does not take buffers as large as this size needs. Try a smaller size or fewer seconds.',
    'reason.not-enough-memory': 'There is not enough graphics memory ({memory}) for this size. Try a smaller size or fewer seconds.',
    'reason.no-webgpu-variant': 'This model has no WebGPU version.',
    fits: 'This device can make it (it needs about {memory} of graphics memory).',
    error: 'The video could not be made: {message}',
  },
};
const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' || (!params.get('lang') && !navigator.language?.startsWith('es')) ? 'en' : 'es';
document.documentElement.lang = lang;
const t = (k, vars = {}) => String(STRINGS[lang][k] ?? k).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? '');
const gb = n => new Intl.NumberFormat(lang, { maximumFractionDigits: n >= 1e9 ? 1 : 0 }).format(n >= 1e9 ? n / 1e9 : n / 1e6) + (n >= 1e9 ? ' GB' : ' MB');
const $ = s => document.querySelector(s);
for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
document.title = t('title');
$('[data-t="intro"]').textContent = t('intro');

const form = $('[data-role="form"]'), start = $('[data-action="start"]'), cancel = $('[data-action="cancel"]');
const gate = $('[data-role="gate"]'), status = $('[data-role="status"]'), bar = $('progress');
const fill = (sel, values, def, label = v => v) => { for (const v of values) sel.append(new Option(label(v), v, false, String(v) === String(def))); };
fill(form.size, SIZES, SIZES[0], v => v.replace('x', ' × '));
fill(form.seconds, Array.from({ length: SECONDS.max - SECONDS.min + 1 }, (_, i) => SECONDS.min + i), SECONDS.default);
fill(form.steps, Array.from({ length: STEPS.max - STEPS.min + 1 }, (_, i) => STEPS.min + i), STEPS.default);
form.prompt.value = params.get('prompt') || '';
for (const k of ['size', 'seconds', 'steps', 'seed']) if (params.get(k)) form[k].value = params.get(k);

// The model store stands in for the local weight cache: pinned URL → /hf/<repo>/<revision>/<path>.
const registry = await (await fetch('../../../registry/tasks.json')).json();
const local = url => url.replace(/^https:\/\/huggingface\.co\/(.+?)\/resolve\/([0-9a-f]{40})\//, '/hf/$1/$2/');
const store = {
  async has(url, bytes) { const r = await fetch(local(url), { method: 'HEAD' }); return r.ok && Number(r.headers.get('content-length')) === bytes; },
  async get(url, { bytes, onProgress }) {
    const r = await fetch(local(url));
    if (!r.ok) throw new Error('not in the weight cache: ' + url);
    const blob = await r.blob(); // a stream of parts kept in memory would not survive the browser's blob limits
    onProgress?.({ loaded: blob.size, total: bytes });
    return blob;
  },
  cancel() {}, dispose() {},
};
const model = registry.models[registry.tasks['text-to-video'].default];
const options = () => ({ prompt: form.prompt.value, size: form.size.value, seconds: Number(form.seconds.value), steps: Number(form.steps.value), ...(form.seed.value ? { seed: Number(form.seed.value) } : {}) });

let ready = false;
async function check() {
  gate.textContent = t('checking');
  start.disabled = true;
  const est = await estimate(options(), { registry, store });
  ready = est.fits;
  gate.textContent = est.fits ? t('fits', { memory: gb(est.memoryBytes) }) : t('reason.' + est.reason, { memory: gb(est.memoryBytes) });
  start.textContent = est.missingBytes ? t('downloadAndRun', { size: gb(est.missingBytes) }) : t('run');
  $('[data-role="model"]').textContent = t('model', { name: model.name[lang], size: gb(est.downloadBytes) });
  start.disabled = !est.fits || !form.prompt.value.trim();
  window.__estimate = est;
}
for (const el of [form.size, form.seconds, form.steps]) el.addEventListener('change', () => check());
form.prompt.addEventListener('input', () => { start.disabled = !ready || !form.prompt.value.trim(); });

let controller = null, url = null, file = null;
cancel.addEventListener('click', () => controller?.abort());
$('[data-action="download"]').addEventListener('click', () => {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url; a.download = file; a.click();
});
form.addEventListener('submit', async e => {
  e.preventDefault();
  controller = new AbortController();
  start.disabled = true; cancel.hidden = false; bar.hidden = false; bar.removeAttribute('value');
  const t0 = performance.now();
  const onProgress = p => {
    if (p.stage === 'download') { if (p.total) { bar.value = p.loaded / p.total; status.textContent = t('stage.download', { loaded: gb(p.loaded || 0), total: gb(p.total) }); } return; }
    if (!p.stage) return;
    const n = (p.index ?? 0) + 1, count = p.count ?? 1;
    bar.value = p.stage === 'step' ? (p.index ?? 0) / count : n / count;
    status.textContent = t('stage.' + p.stage, { n, count });
    window.__stages = [...(window.__stages || []), { stage: p.stage, index: p.index, at: performance.now() - t0 }];
  };
  const task = new TextToVideo({ registry, store, onProgress, signal: controller.signal });
  try {
    const sound = form.sound.files[0];
    const audio = sound ? await decodeSoundtrack(sound) : undefined;
    const r = await task.run(null, { ...options(), ...(audio ? { audio } : {}) });
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(r.blob);
    file = `video-${r.seed}.${r.mime.startsWith('video/webm') ? 'webm' : 'mp4'}`;
    const video = $('section.result video');
    video.src = url; video.play().catch(() => {});
    $('[data-role="meta"]').textContent = t('meta', { ...r, seconds: r.seconds.toFixed(1) });
    $('section.result').hidden = false;
    status.textContent = t('done', { time: `${Math.round((performance.now() - t0) / 1000)} s` });
    window.__result = { ...r, blob: r.blob.size };
  } catch (err) {
    status.textContent = err?.code === 'aborted' ? t('cancelled') : t('error', { message: err?.message || String(err) });
    window.__error = { code: err?.code, message: err?.message };
  } finally {
    await task.dispose();
    controller = null; cancel.hidden = true; bar.hidden = true; start.disabled = !ready;
    check();
  }
});
await check();
window.__pageReady = true;
