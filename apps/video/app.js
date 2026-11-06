// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// video.elffuss.com: a photo in, a video out. A thin page over the
// image-to-video task (sdk/video/): the task works out the photo's layers once
// (depth, and what is behind the subject), the page plays the camera move live
// with the same renderer the export uses, and the primary button makes the MP4.
// The first time, the button says what it downloads and its size and does it
// all in one click; once the models are here, a chosen photo goes straight to
// its video. Changing a setting changes the live preview at once; the button
// makes the video again with it.

import { createShell, AiError } from './shared/shell.js';
import { Video, PRESETS, ASPECTS, LOOPS, planCamera, cameraAt, createRenderer, pageQuality, decodeSoundtrack } from './sdk/video/index.js';
import { sniffImageType, DECODABLE, previewImage } from './sdk/core/image-input.js';
import { integration, blobOf } from './hooks.js';

const PREVIEW_SIDE = 1600;

const shell = await createShell();
const { t } = shell;
const $ = s => document.querySelector(s);
const ui = {
  preview: $('main [data-role="preview"]'), still: $('main [data-role="still"]'), live: $('main [data-role="live"]'), caption: $('main [data-role="preview-caption"]'),
  playback: $('main [data-role="playback"]'), play: $('main [data-action="play"]'), time: $('main [data-input="time"]'),
  preset: $('main [data-input="preset"]'), aspect: $('main [data-input="aspect"]'), seconds: $('main [data-input="seconds"]'), secondsValue: $('main [data-role="seconds-value"]'),
  strength: $('main [data-input="strength"]'), dof: $('main [data-input="dof"]'), sound: $('main [data-input="sound"]'),
  soundFileRow: $('main [data-role="sound-file"]'), soundFile: $('main [data-input="sound-file"]'), soundName: $('main [data-role="sound-name"]'),
  cancel: $('main [data-action="cancel"]'), modes: $('main [data-role="modes"]'), makeImage: $('main [data-role="make-image"]'),
};
const quality = pageQuality();
const runner = shell.taskRunner(o => new Video({ ...o, onProgress: p => { shell.onProgress(p); stage(p); } }));
const probe = shell.config.testHooks ? (shell.diagnostics.video = { runs: 0, scenes: 0, frames: 0 }) : null;
const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

let current = null; // { file, name, url }
let scene = null; // { forFile, value }
let preview = null; // { renderer, plan, raf, t0, playing }
let shown = null; // { url }
let soundtrack = null; // { blob, name } or a generated one
let picks = 0;

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
  n.append(...children.filter(c => c != null && c !== false));
  return n;
}

const baseName = name => String(name || '').replace(/\.[^./\\]*$/, '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').trim() || t('file.name');

/** The settings as the task takes them (plain data). */
function settings() {
  return {
    preset: ui.preset.value, aspect: ui.aspect.value, seconds: Number(ui.seconds.value), fps: 30, quality,
    strength: Number(ui.strength.value) / 100, effects: { dof: ui.dof.checked ? 0.8 : 0, vignette: 0.35, grain: 0 },
  };
}

/** Progress of the task, by stage. */
function stage(p) {
  if (p.status !== 'running' || !p.stage) return;
  if (p.stage === 'render') {
    shell.setStatus(t('stage.render', { frame: p.frame || 0, frames: p.frames || 0 }));
    const bar = shell.els.progress;
    if (bar && p.frames) { bar.hidden = false; bar.max = p.frames; bar.value = p.frame || 0; }
    if (probe) probe.frames = p.frame || 0;
  } else if (t('stage.' + p.stage) !== 'stage.' + p.stage) shell.setStatus(t('stage.' + p.stage));
}

function forgetResult() {
  if (shown) URL.revokeObjectURL(shown.url);
  shown = null;
  shell.clearResult();
}

function stopPreview() {
  if (!preview) return;
  cancelAnimationFrame(preview.raf);
  preview.renderer.dispose();
  preview = null;
  ui.live.hidden = true; ui.playback.hidden = true; ui.still.hidden = false;
}

/** A photo was chosen: check it, show a small copy, and run when the models are here. */
async function choose(file) {
  const pick = ++picks;
  forgetResult(); stopPreview();
  scene = null;
  if (current) URL.revokeObjectURL(current.url);
  current = null;
  ui.preview.hidden = true;
  shell.setReady(false);
  let type = null;
  try { type = sniffImageType(new Uint8Array(await file.slice(0, 32).arrayBuffer())); } catch { type = null; }
  if (pick !== picks) return;
  if (!DECODABLE.includes(type)) { shell.showError(new AiError(file.size ? 'unsupported-format' : 'decode-failed', 'not an image this site reads')); return; }
  let small;
  try { small = await previewImage(file, { maxSide: PREVIEW_SIDE }); } catch (err) { if (pick === picks) shell.showError(err); return; }
  if (pick !== picks) return;
  const url = URL.createObjectURL(small.blob);
  current = { file, name: baseName(file.name), url };
  ui.still.src = url;
  ui.still.width = small.width; ui.still.height = small.height;
  ui.caption.textContent = t('preview.caption', { name: file.name, width: small.sourceWidth, height: small.sourceHeight });
  ui.preview.hidden = false;
  if (!shell.busy) shell.setStatus('');
  shell.setReady(!shell.busy);
  await shell.inputReady();
}

/** The live preview: the scene's layers drawn at the size the page shows, playing the move. */
function startPreview(value) {
  stopPreview();
  const canvas = ui.live;
  const s = settings();
  const r = ASPECTS[s.aspect];
  const side = Math.min(1280, Math.round((ui.preview.clientWidth || 800) * Math.min(2, devicePixelRatio || 1)));
  canvas.width = Math.max(64, Math.round(r >= 1 ? side : side * r) & ~1);
  canvas.height = Math.max(64, Math.round(r >= 1 ? side / r : side) & ~1);
  let renderer;
  try { renderer = createRenderer(canvas, { msaa: 4, grid: 320, preserve: true }); }
  catch { shell.setStatus(t('unsupported')); return; }
  renderer.setScene(value);
  preview = { renderer, plan: null, raf: 0, t0: performance.now(), playing: !reduced, at: 0 };
  replan();
  ui.still.hidden = true; ui.live.hidden = false; ui.playback.hidden = false;
  ui.play.textContent = preview.playing ? t('live.pause') : t('live.play');
  ui.play.setAttribute('aria-pressed', String(preview.playing));
  if (reduced) shell.setStatus(t('play.reduced'));
  const frame = now => {
    if (!preview) return;
    const dur = Number(ui.seconds.value) * 1000;
    if (preview.playing) preview.at = ((now - preview.t0) % dur) / dur;
    ui.time.value = String(Math.round(preview.at * 1000));
    preview.renderer.draw(cameraAt(preview.plan, preview.at), { ...settings().effects });
    preview.raf = requestAnimationFrame(frame);
  };
  preview.raf = requestAnimationFrame(frame);
}

/** Plan the move again for the current settings (instant; no model runs). */
function replan() {
  if (!preview || !scene) return;
  const s = settings();
  const r = ASPECTS[s.aspect];
  const v = scene.value;
  if (Math.abs(preview.renderer.gl.canvas.width / preview.renderer.gl.canvas.height - r) > 0.02) { startPreview(v); return; }
  preview.plan = planCamera({ preset: s.preset, aspect: r, A: v.A, focus: v.focus, relief: v.relief, strength: s.strength, borders: v.borders });
}

async function show(job, result, device, fallback) {
  const section = shell.showResult();
  const url = URL.createObjectURL(result.blob);
  shown = { url };
  const ext = result.container === 'webm' ? 'webm' : 'mp4';
  const name = `${job.name}-${t('download.suffix')}.${ext}`;
  const download = el('button', { class: 'ghost', type: 'button', 'data-action': 'download' }, t('download.video'));
  download.addEventListener('click', () => shell.download(result.blob, name));
  const player = el('video', { src: url, controls: true, loop: true, playsinline: true, muted: !result.audioCodec, 'data-role': 'player' });
  const notes = [];
  if (fallback) notes.push(t('fallback.wasm'));
  if (result.container === 'webm') notes.push(t('result.webm'));
  if (result.layers <= 1) notes.push(t('result.flat'));
  if (job.sound && !result.audioCodec) notes.push(t('result.noSound'));
  section.append(el('article', { class: 'card', 'data-role': 'video' },
    el('h3', {}, name),
    el('p', { class: 'actions' }, download),
    player,
    el('p', { class: 'muted', 'data-role': 'result-meta' }, t('result.meta', { width: result.width, height: result.height, seconds: result.seconds, container: ext.toUpperCase(), size: (result.bytes / 1e6).toFixed(1), device: shell.deviceLabel(device) })),
    ...notes.map(text => el('p', { 'data-role': 'note' }, text))));
  download.scrollIntoView?.({ block: 'nearest' });
  if (probe) Object.assign(probe, { runs: probe.runs + 1, device, fallback, width: result.width, height: result.height, container: result.container, videoCodec: result.videoCodec, audioCodec: result.audioCodec, bytes: result.bytes, layers: result.layers, preset: result.preset, aspect: result.aspect });
}

shell.onPrimary(async ({ signal }) => {
  if (!current) return;
  const job = { ...current, sound: soundtrack };
  forgetResult();
  ui.cancel.hidden = false;
  try {
    if (!scene || scene.forFile !== job.file) {
      const { result } = await runner.run(job.file, { signal, output: 'scene', quality, previewSide: 1280 });
      if (current?.file !== job.file) return;
      scene = { forFile: job.file, value: result };
      if (probe) { probe.scenes++; probe.layers = result.layers.length; Object.defineProperty(probe, 'scene', { value: result, configurable: true, enumerable: false }); }
      startPreview(result);
    }
    const audio = job.sound?.blob || job.sound?.pcm || null;
    const { result, device, fallback } = await runner.run(job.file, { signal, ...settings(), ...(audio ? { audio } : {}) });
    if (current?.file === job.file) await show(job, result, device, fallback);
  } finally {
    ui.cancel.hidden = true;
  }
});

// Settings: the preview follows them at once.
for (const c of [ui.preset, ui.aspect, ui.strength, ui.dof]) c.addEventListener('input', replan);
ui.seconds.addEventListener('input', () => { ui.secondsValue.textContent = `${ui.seconds.value} s`; });
ui.play.addEventListener('click', () => {
  if (!preview) return;
  preview.playing = !preview.playing;
  preview.t0 = performance.now() - preview.at * Number(ui.seconds.value) * 1000;
  ui.play.textContent = preview.playing ? t('live.pause') : t('live.play');
  ui.play.setAttribute('aria-pressed', String(preview.playing));
});
ui.time.addEventListener('input', () => { if (!preview) return; preview.playing = false; preview.at = Number(ui.time.value) / 1000; ui.play.textContent = t('live.play'); ui.play.setAttribute('aria-pressed', 'false'); });

// The soundtrack: a file of the person's, or music from the audio module once it ships with the site.
ui.sound.addEventListener('change', () => {
  ui.soundFileRow.hidden = ui.sound.value !== 'file';
  if (ui.sound.value === 'none') { soundtrack = null; ui.soundName.textContent = ''; }
});
ui.soundFile.addEventListener('change', async () => {
  const f = ui.soundFile.files?.[0];
  if (!f) return;
  try { await decodeSoundtrack(f); soundtrack = { blob: f, name: f.name }; ui.soundName.textContent = t('sound.chosen', { name: f.name }); }
  catch { soundtrack = null; ui.soundName.textContent = t('sound.bad'); }
});

// Integrations: each appears only when its module ships with this build (hooks.js).
integration('music').then(music => {
  if (!music) return;
  const opt = ui.sound.querySelector('option[value="music"]');
  opt.hidden = false;
  ui.sound.addEventListener('change', async () => {
    if (ui.sound.value !== 'music') return;
    const out = await music({ seconds: Number(ui.seconds.value) });
    const blob = blobOf(out);
    soundtrack = blob ? { blob, name: t('sound.music') } : out?.channels ? { pcm: out, name: t('sound.music') } : null;
    ui.soundName.textContent = soundtrack ? t('sound.chosen', { name: soundtrack.name }) : '';
  });
});
integration('image').then(make => {
  if (!make) return;
  ui.makeImage.hidden = false;
  ui.makeImage.querySelector('button').addEventListener('click', async () => {
    const blob = blobOf(await make({ aspect: ui.aspect.value }));
    if (blob) choose(new File([blob], `${t('file.name')}.png`, { type: blob.type || 'image/png' })).catch(err => shell.showError(err));
  });
});
integration('textToVideo').then(gen => { if (gen) ui.modes.hidden = false; });

if (PRESETS.length !== ui.preset.options.length || LOOPS.some(p => !PRESETS.includes(p))) shell.setStatus(t('unsupported'));
const fit = await Video.estimate({ registry: shell.registry, model: shell.modelId, quality }, shell.requested).catch(() => null);
if (fit && !fit.fits && fit.reason !== 'webgpu-unavailable' && fit.reason !== 'device-unsupported') shell.setStatus(t('unsupported'));
shell.bindInput({ onFiles: files => { if (files[0]) choose(files[0]).catch(err => shell.showError(err)); }, paste: true });
ui.cancel.addEventListener('click', () => shell.cancel());
shell.setReady(false);
