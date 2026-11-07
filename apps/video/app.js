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

import { createShell, AiError, formatSize } from './shared/shell.js';
import { Video, PRESETS, ASPECTS, LOOPS, planCamera, cameraAt, createRenderer, pageQuality, decodeSoundtrack } from './sdk/video/index.js';
import { sniffImageType, DECODABLE, previewImage } from './sdk/core/image-input.js';
import { integration, blobOf, shipped } from './hooks.js';
import { createStoryView } from './story-view.js';

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
  settings: $('main [data-role="settings"]'), modelImage: $('main [data-role="model"]'), modelText: $('main [data-role="model-text"]'),
  textSettings: $('main [data-role="text-settings"]'), prompt: $('main [data-input="prompt"]'), size: $('main [data-input="size"]'),
  genSeconds: $('main [data-input="gen-seconds"]'), steps: $('main [data-input="steps"]'), seed: $('main [data-input="seed"]'), textGate: $('main [data-role="text-gate"]'),
  modeStory: $('main [data-role="mode-story"]'), storySettings: $('main [data-role="story-settings"]'), storyPrompt: $('main [data-input="story-prompt"]'),
  storySeconds: $('main [data-input="story-seconds"]'), storySize: $('main [data-input="story-size"]'), storyStart: $('main [data-input="story-start"]'),
  storyEnd: $('main [data-input="story-end"]'), storySeed: $('main [data-input="story-seed"]'), storyPhotos: $('main [data-role="story-photos"]'),
  storyGate: $('main [data-role="story-gate"]'), story: $('main [data-role="story"]'), modelStory: $('main [data-role="model-story"]'),
};
// The modes of the page: a photo animated (the site's own model); where the module
// video-gen ships and this browser has WebGPU, a video made from a text (the site's
// second model, config.models[1]); and, where text-to-image ships too, a video with a
// storyboard that does what it is asked (the third, config.models[2]).
const imageModel = shell.modelId;
const textModel = (shell.config.models || [])[1] || null;
const storyModel = (shell.config.models || [])[2] || null;
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
let mode = 'image';
let gen = null; // the module video-gen, once the text mode is offered
let fit = null; // what estimate() said of the text mode's current settings
let textChecks = 0;
let imageHook = false; // the "make an image" integration is on
let storyFit = null; // what estimateStory() said
let storyChecks = 0;
const storyPics = { start: null, end: null }; // { picture, size, name } of the photos given
let view = null; // the storyboard's progress view

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
  const bar = shell.els.progress;
  if (p.stage === 'render') {
    shell.setStatus(t('stage.render', { frame: p.frame || 0, frames: p.frames || 0 }));
    if (bar && p.frames) { bar.hidden = false; bar.max = p.frames; bar.value = p.frame || 0; }
    if (probe) probe.frames = p.frame || 0;
  } else if (t('stage.' + p.stage) !== 'stage.' + p.stage) {
    // The text mode's stages count their steps (index of count).
    const n = (p.index ?? 0) + 1, count = p.count ?? 1;
    shell.setStatus(t('stage.' + p.stage, { n, count }));
    if (bar && p.count > 1) { bar.hidden = false; bar.max = count; bar.value = p.stage === 'step' ? n - 1 : n; }
    if (probe && mode === 'text') probe.stages = [...(probe.stages || []), p.stage];
  }
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
  preview.plan = planCamera({ preset: s.preset, aspect: r, A: v.A, focus: v.focus, relief: v.relief, strength: s.strength, borders: v.borders, parallax: v.parallax || [] });
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

/** The text mode: the settings as the task takes them. */
function textOptions() {
  const seed = ui.seed.value.trim();
  return { prompt: ui.prompt.value, size: ui.size.value, seconds: Number(ui.genSeconds.value), steps: Number(ui.steps.value), ...(seed ? { seed: Number(seed) } : {}) };
}

/** The primary button of the text mode: on when the device can make it and there is a description. */
function textReady() {
  if (mode === 'text' && !shell.busy) shell.setReady(Boolean(fit?.fits) && Boolean(ui.prompt.value.trim()));
}

/** Can this device make the video the text mode's settings ask for? Downloads nothing. */
async function checkText() {
  const ask = ++textChecks;
  fit = null;
  ui.textGate.textContent = t('text.checking');
  shell.setReady(false);
  let est;
  try { est = await gen.estimate(textOptions(), { registry: shell.registry, model: textModel, store: shell.store }); }
  catch (err) { if (ask === textChecks && mode === 'text') { ui.textGate.textContent = ''; shell.showError(err); } return; }
  if (ask !== textChecks || mode !== 'text') return;
  fit = est;
  const memory = formatSize(est.memoryBytes || 0, shell.lang);
  ui.textGate.textContent = est.fits ? t('text.fits', { memory }) : t('text.reason.' + est.reason, { memory });
  if (probe) probe.estimate = { fits: est.fits, reason: est.reason, missingBytes: est.missingBytes, downloadBytes: est.downloadBytes };
  textReady();
}

/** Switch between the photo and the text. Nothing runs; a result on screen goes. */
async function setMode(next) {
  if (next === mode || ((next === 'text' || next === 'story') && !gen) || (next === 'story' && ui.modeStory.hidden)) return;
  if (shell.busy) { for (const r of document.querySelectorAll('main [data-input="mode"]')) r.checked = r.value === mode; return; }
  mode = next;
  const text = mode === 'text', story = mode === 'story', image = mode === 'image';
  forgetResult();
  if (!image) stopPreview();
  ui.textSettings.hidden = !text; ui.modelText.hidden = !text;
  ui.storySettings.hidden = !story; ui.modelStory.hidden = !story; ui.story.hidden = !story || !view;
  ui.settings.hidden = !image; ui.modelImage.hidden = !image;
  if (shell.els.drop) shell.els.drop.hidden = !image;
  ui.makeImage.hidden = !image || !imageHook;
  ui.preview.hidden = !image || !current;
  for (const r of document.querySelectorAll('main [data-input="mode"]')) r.checked = r.value === mode;
  const n = story ? 3 : text ? 2 : 1;
  shell.useModel(story ? storyModel : text ? textModel : imageModel, { sizeEl: $(n > 1 ? `[data-role="model-size-${n}"]` : '[data-role="model-size"]') });
  if (probe) probe.mode = mode;
  if (text) await checkText();
  else if (story) await checkStory();
  else {
    if (current && scene?.forFile === current.file) startPreview(scene.value);
    shell.setReady(Boolean(current) && !shell.busy);
  }
}

/** The text mode's run: one video from the description, then the model is released. */
async function runText(signal) {
  const opts = textOptions();
  forgetResult();
  ui.cancel.hidden = false;
  const task = new gen.TextToVideo(shell.taskOptions({ device: 'webgpu', model: textModel, onProgress: p => { shell.onProgress(p); stage(p); } }));
  try {
    const result = await task.run(null, { ...opts, signal });
    if (mode === 'text') showText(result, opts);
  } finally {
    ui.cancel.hidden = true;
    await task.dispose().catch(() => {});
  }
}

function showText(r, opts) {
  const section = shell.showResult();
  const url = URL.createObjectURL(r.blob);
  shown = { url };
  const ext = /webm/.test(r.mime) ? 'webm' : 'mp4';
  const name = `${t('text.file')}-${r.seed}.${ext}`;
  const download = el('button', { class: 'ghost', type: 'button', 'data-action': 'download' }, t('download.video'));
  download.addEventListener('click', () => shell.download(r.blob, name));
  const player = el('video', { src: url, controls: true, loop: true, playsinline: true, muted: true, 'data-role': 'player' });
  section.append(el('article', { class: 'card', 'data-role': 'video' },
    el('h3', {}, name),
    el('p', { class: 'actions' }, download),
    player,
    el('p', { class: 'muted', 'data-role': 'result-meta' }, t('text.meta', { width: r.width, height: r.height, seconds: Number(r.seconds).toFixed(1), container: ext.toUpperCase(), size: (r.blob.size / 1e6).toFixed(1), seed: r.seed })),
    ...(ext === 'webm' ? [el('p', { 'data-role': 'note' }, t('result.webm'))] : [])));
  download.scrollIntoView?.({ block: 'nearest' });
  if (probe) probe.text = { runs: (probe.text?.runs || 0) + 1, width: r.width, height: r.height, frames: r.frames, seed: r.seed, steps: r.steps, mime: r.mime, bytes: r.blob.size, prompt: opts.prompt };
}

/** The storyboard's size: the start photo's shape (or the end photo's), else the one chosen. */
function storySize() {
  return (storyPics.start || storyPics.end)?.size || ui.storySize.value;
}

/** The primary button of the storyboard: on when the device can make it and there is a description or two photos. */
function storyReady() {
  if (mode === 'story' && !shell.busy) shell.setReady(Boolean(storyFit?.fits) && (Boolean(ui.storyPrompt.value.trim()) || Boolean(storyPics.start && storyPics.end)));
}

async function checkStory() {
  const ask = ++storyChecks;
  storyFit = null;
  ui.storyGate.textContent = t('text.checking');
  shell.setReady(false);
  let est;
  try { est = await gen.estimateStory({ seconds: Number(ui.storySeconds.value), size: storySize() }, { registry: shell.registry, model: storyModel, store: shell.store }); }
  catch (err) { if (ask === storyChecks && mode === 'story') { ui.storyGate.textContent = ''; shell.showError(err); } return; }
  if (ask !== storyChecks || mode !== 'story') return;
  storyFit = est;
  const memory = formatSize(est.memoryBytes || 0, shell.lang);
  ui.storyGate.textContent = est.fits ? t('story.fits', { memory, clips: est.clips }) : t('text.reason.' + est.reason, { memory });
  if (probe) probe.storyEstimate = { fits: est.fits, reason: est.reason, missingBytes: est.missingBytes, downloadBytes: est.downloadBytes, size: `${est.width}x${est.height}` };
  storyReady();
}

/** A start or end photo chosen: read it small; its shape sets the video's. */
async function storyPhoto(which, input) {
  const f = input.files?.[0];
  storyPics[which] = null;
  if (f) {
    try { storyPics[which] = { ...(await gen.readPhoto(f)), name: f.name }; }
    catch { input.value = ''; shell.setStatus(t('story.badPhoto')); }
  }
  const sz = storySize();
  ui.storySize.disabled = Boolean(storyPics.start || storyPics.end);
  ui.storySize.value = sz;
  const names = ['start', 'end'].filter(k => storyPics[k]).map(k => t(`story.${k}Named`, { name: storyPics[k].name }));
  ui.storyPhotos.textContent = names.length ? `${names.join(' · ')} ${t('story.photoSize', { size: sz.replace('x', ' × ') })}` : '';
  await checkStory();
}

/** The storyboard's run: the keyframes, a look at them (continue or change), then the clips. */
async function runStory(signal) {
  const lang = shell.lang;
  const seed = ui.storySeed.value.trim() ? Number(ui.storySeed.value) : (crypto.getRandomValues(new Uint32Array(1))[0] >>> 1);
  const plan = gen.planStory({ prompt: ui.storyPrompt.value, seconds: Number(ui.storySeconds.value), start: Boolean(storyPics.start), end: Boolean(storyPics.end), seed, lang });
  const size = storySize();
  const photos = { ...(storyPics.start ? { start: storyPics.start.picture } : {}), ...(storyPics.end ? { end: storyPics.end.picture } : {}) };
  forgetResult();
  view?.dispose();
  view = createStoryView(ui.story, { t, reduced });
  ui.story.hidden = false;
  view.setPlan(plan, { size });
  ui.cancel.hidden = false;
  const onProgress = p => {
    shell.onProgress(p);
    if (p.stage === 'keyframe') {
      view.keyframe(p.index, p);
      shell.setStatus(t('story.stage.keyframe', { n: p.index + 1, count: p.count }));
    } else if (p.stage === 'clip') {
      if (p.done) view.clipDone(p.clip, p); else view.clipStep(p.clip, p);
      shell.setStatus(t('story.stage.clip', { n: p.clip + 1, count: p.clips, step: Math.min(p.count, p.index + 1), steps: p.count }));
    } else if (p.stage) stage(p);
    if (probe && p.stage) probe.stages = [...(probe.stages || []), p.stage];
  };
  const task = new gen.StoryVideo(shell.taskOptions({ device: 'webgpu', model: storyModel, onProgress }));
  try {
    let kf = await task.keyframes({ plan, size, ...photos, signal });
    if (probe) probe.story = { keyframes: kf.keyframes.length, size: kf.size };
    shell.setStatus(t('story.look'));
    if (await view.askContinue() === 'change') {
      view.editable(true, async (k, text) => {
        plan.shots[k].prompt = text;
        kf = await task.keyframes({ plan, size, ...photos, keyframes: kf.keyframes, only: k, signal });
      });
      await view.askAfterChange();
      view.editable(false);
    }
    const audio = soundtrack?.pcm || (soundtrack?.blob ? await decodeSoundtrack(soundtrack.blob).catch(() => null) : null);
    const r = await task.clips({ plan, size, keyframes: kf.keyframes, ...photos, signal, ...(audio ? { audio } : {}) });
    if (mode === 'story') showStory(r);
  } finally {
    ui.cancel.hidden = true;
    await task.dispose().catch(() => {});
  }
}

function showStory(r) {
  const section = shell.showResult();
  const url = URL.createObjectURL(r.blob);
  shown = { url };
  const ext = /webm/.test(r.mime) ? 'webm' : 'mp4';
  const name = `${t('story.file')}-${r.seed}.${ext}`;
  const download = el('button', { class: 'ghost', type: 'button', 'data-action': 'download' }, t('download.video'));
  download.addEventListener('click', () => shell.download(r.blob, name));
  section.append(el('article', { class: 'card', 'data-role': 'video' },
    el('h3', {}, name), el('p', { class: 'actions' }, download),
    el('video', { src: url, controls: true, loop: true, playsinline: true, muted: true, 'data-role': 'player' }),
    el('p', { class: 'muted', 'data-role': 'result-meta' }, t('text.meta', { width: r.width, height: r.height, seconds: Number(r.seconds).toFixed(1), container: ext.toUpperCase(), size: (r.blob.size / 1e6).toFixed(1), seed: r.seed }))));
  download.scrollIntoView?.({ block: 'nearest' });
  if (probe) probe.story = { ...(probe.story || {}), runs: (probe.story?.runs || 0) + 1, width: r.width, height: r.height, frames: r.frames, clips: r.clips, seed: r.seed, mime: r.mime, bytes: r.blob.size };
}

shell.onPrimary(async ({ signal }) => {
  if (mode === 'text') { await runText(signal); return; }
  if (mode === 'story') { await runStory(signal); return; }
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
}, { after: () => { textReady(); storyReady(); } });

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
  imageHook = true;
  ui.makeImage.hidden = mode === 'text';
  ui.makeImage.querySelector('button').addEventListener('click', async () => {
    const blob = blobOf(await make({ aspect: ui.aspect.value }));
    if (blob) choose(new File([blob], `${t('file.name')}.png`, { type: blob.type || 'image/png' })).catch(err => shell.showError(err));
  });
});
integration('textToVideo').then(async fn => {
  if (!fn || !textModel) return;
  try { gen = await import('./sdk/video-gen/index.js'); } catch { return; }
  const opt = (sel, values, def, label) => { for (const v of values) sel.append(new Option(label(v), String(v), false, String(v) === String(def))); };
  opt(ui.size, gen.SIZES, gen.SIZES[0], v => v.replace('x', ' × '));
  const range = ({ min, max }) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
  opt(ui.genSeconds, range(gen.SECONDS), gen.SECONDS.default, n => t('text.secondsValue', { n }));
  opt(ui.steps, range(gen.STEPS), gen.STEPS.default, n => String(n));
  // The seed does not change what the device needs (a bad one is refused by the run
  // itself): it never re-checks, so leaving its field to press the button keeps the button on.
  for (const c of [ui.size, ui.genSeconds, ui.steps]) c.addEventListener('change', () => { if (mode === 'text') checkText(); });
  ui.prompt.addEventListener('input', textReady);
  for (const r of document.querySelectorAll('main [data-input="mode"]')) r.addEventListener('change', () => { if (r.checked) setMode(r.value).catch(err => shell.showError(err)); });
  ui.modes.hidden = false;
  if (probe) probe.modes = true;
  // The storyboard: its model listed by the site and in the registry, and text-to-image shipped.
  if (storyModel && gen.StoryVideo && shell.registry.models?.[storyModel] && shipped(shell.config).includes('text-to-image')) {
    ui.modeStory.hidden = false;
    for (const c of [ui.storySeconds, ui.storySize]) c.addEventListener('change', () => { if (mode === 'story') checkStory(); });
    ui.storyPrompt.addEventListener('input', storyReady);
    ui.storyStart.addEventListener('change', () => storyPhoto('start', ui.storyStart).catch(err => shell.showError(err)));
    ui.storyEnd.addEventListener('change', () => storyPhoto('end', ui.storyEnd).catch(err => shell.showError(err)));
    if (probe) probe.storyMode = true;
  }
});

if (PRESETS.length !== ui.preset.options.length || LOOPS.some(p => !PRESETS.includes(p))) shell.setStatus(t('unsupported'));
const photoFit = await Video.estimate({ registry: shell.registry, model: imageModel, quality }, shell.requested).catch(() => null);
if (photoFit && !photoFit.fits && photoFit.reason !== 'webgpu-unavailable' && photoFit.reason !== 'device-unsupported') shell.setStatus(t('unsupported'));
shell.bindInput({ onFiles: async files => {
  if (!files[0]) return;
  if (mode === 'text') await setMode('image'); // a photo dropped or pasted on the text mode: back to the photo
  choose(files[0]).catch(err => shell.showError(err));
}, paste: true });
ui.cancel.addEventListener('click', () => shell.cancel());
shell.setReady(false);
