// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// audio.elffuss.com: music, sound effects and speech from text, made in this
// browser. A thin page over the SDK's audio tasks (Music, Sfx, Speech): the mode
// picks the model; the primary button names its action and, the first time, the
// download; the result plays in a waveform player and downloads as WAV (and OGG
// where the browser encodes Opus); the clips stay in this site's own history.
import { createShell } from './shared/shell.js';
import { Music, Sfx, Speech, VOICES, DEFAULT_VOICE, SPEED, DURATION, STEPS, MAX_SEED, decodeWav } from './sdk/audio/index.js';
import { createPlayer } from './player.js';
import { createHistory, LIMIT } from './history.js';
import { canEncodeOgg, encodeOgg } from './ogg.js';
import { icon } from './icons.js';

const shell = await createShell();
const { t, lang } = shell;
const $ = s => document.querySelector(s);
const history = createHistory();
const probe = shell.config.testHooks ? (shell.diagnostics.audio = { runs: 0, last: null }) : null;
const oggReady = canEncodeOgg();

const modelOf = task => shell.config.models.find(id => id.startsWith(task + '/'));
const MODES = {
  music: { model: modelOf('text-to-music'), Task: Music, task: 'text-to-music' },
  sfx: { model: modelOf('text-to-sfx'), Task: Sfx, task: 'text-to-sfx' },
  speech: { model: modelOf('text-to-speech'), Task: Speech, task: 'text-to-speech' },
};
const IDEAS = {
  music: {
    lofi: 'Lo-fi hip hop beat with mellow Rhodes chords, soft vinyl crackle, brushed drums and a warm upright bass, 80 BPM',
    orchestral: 'Epic cinematic orchestral piece with soaring strings, bold French horns, choir and thunderous taiko drums, 110 BPM',
    synthwave: 'Retro synthwave track with pulsing arpeggiated synths, gated reverb drums, a deep bassline and a nostalgic lead melody, 100 BPM',
    guitar: 'TrackType: Instrument, a gentle solo acoustic guitar with delicate finger picking and a warm room reverb',
    house: 'Deep house groove with a four-to-the-floor kick, warm sub bass, airy pads and soulful chord stabs, 122 BPM',
  },
  sfx: {
    rain: 'TrackType: SFX, heavy rain falling on a tin roof with distant rolling thunder',
    door: 'TrackType: SFX, a heavy wooden door creaking open slowly, then slamming shut in a stone hallway',
    steps: 'TrackType: SFX, slow footsteps crunching on fresh snow, close microphone',
    laser: 'TrackType: SFX, a sci-fi laser blast with a bright attack and a short metallic tail',
    crowd: 'TrackType: SFX, a small theatre audience applauding and cheering',
  },
};

const els = {
  modes: [...document.querySelectorAll('.modes [data-mode]')],
  prompt: $('[data-input="prompt"]'), promptLabel: $('[data-role="prompt-label"]'), promptHint: $('[data-role="prompt-hint"]'), ideas: $('[data-role="ideas"]'),
  seconds: $('[data-input="seconds"]'), secondsOut: $('[data-role="seconds-out"]'), seed: $('[data-input="seed"]'),
  steps: $('[data-input="steps"]'), stepsOut: $('[data-role="steps-out"]'),
  text: $('[data-input="text"]'), textCount: $('[data-role="text-count"]'), voice: $('[data-input="voice"]'), speed: $('[data-input="speed"]'), speedOut: $('[data-role="speed-out"]'),
  credits: $('[data-role="credits"]'), cancel: $('button[data-action="cancel"]'),
  historyList: $('[data-role="history-list"]'), historyEmpty: $('[data-role="history-empty"]'), historyTools: $('[data-role="history-tools"]'), historyNote: $('[data-role="history-note"]'),
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  node.append(...children.filter(c => c != null && c !== false));
  return node;
}
function button(action, text, onClick, extra = {}) {
  const b = el('button', { class: 'ghost', type: 'button', 'data-action': action, ...extra }, text);
  b.addEventListener('click', async () => { try { await onClick(b); } catch (err) { shell.showError(err); } });
  return b;
}
const num = n => (lang === 'es' ? String(n).replace('.', ',') : String(n));
const short = (s, n = 90) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const slug = s => (s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || t('file.name'));

// ── the composer ────────────────────────────────────────────────────────────
let mode = 'music';
const runners = {};
const lengths = { music: DURATION['text-to-music'].default, sfx: DURATION['text-to-sfx'].default };

for (const v of VOICES) {
  let group = els.voice.querySelector(`optgroup[data-lang="${v.lang}"]`);
  if (!group) { group = el('optgroup', { label: t(v.lang === 'es' ? 'voice.groupEs' : 'voice.groupEn'), 'data-lang': v.lang }); els.voice.append(group); }
  group.append(el('option', { value: v.id }, t(`voice.${v.gender}`, { name: v.name })));
}
els.voice.value = DEFAULT_VOICE[lang];
els.speed.min = String(SPEED.min); els.speed.max = String(SPEED.max);
els.steps.min = String(STEPS.min); els.steps.max = String(STEPS.max); els.steps.value = String(STEPS.default);
const randomButton = $('[data-action="random-seed"]');
randomButton.append(icon('dice'));
randomButton.addEventListener('click', () => { els.seed.value = String(Math.floor(Math.random() * MAX_SEED)); });

const outputs = () => {
  els.secondsOut.textContent = t('seconds.value', { n: num(els.seconds.value) });
  els.stepsOut.textContent = els.steps.value;
  els.speedOut.textContent = t('speed.value', { n: num(Number(els.speed.value).toFixed(2).replace(/0$/, '')) });
  els.textCount.textContent = t('text.count', { n: els.text.value.length });
};
for (const i of [els.seconds, els.steps, els.speed]) i.addEventListener('input', outputs);
els.seconds.addEventListener('input', () => { if (mode !== 'speech') lengths[mode] = Number(els.seconds.value); });
for (const i of [els.prompt, els.text]) i.addEventListener('input', () => { outputs(); readiness(); });
$('[data-role="composer"]').addEventListener('submit', e => e.preventDefault());

function readiness() {
  const has = mode === 'speech' ? els.text.value.trim().length > 0 : els.prompt.value.trim().length > 0;
  shell.setReady(has && !shell.choiceError && !shell.busy);
}

/** Why a mode cannot run here, in the page's words, or null. */
function blockedText() {
  const e = shell.choiceError;
  if (!e) return null;
  if (e.code === 'webgpu-unavailable') return t('need.webgpu');
  if (e.code === 'device-unsupported' && shell.probe.available && !shell.probe.shaderF16) return t('need.f16');
  return null;
}

async function setMode(next) {
  mode = next;
  for (const b of els.modes) b.setAttribute('aria-pressed', String(b.dataset.mode === next));
  const speech = next === 'speech';
  for (const p of document.querySelectorAll('[data-panel="prompt"]')) p.hidden = speech;
  for (const p of document.querySelectorAll('[data-panel="speech"]')) p.hidden = !speech;
  els.credits.hidden = speech;
  if (!speech) {
    const d = DURATION[MODES[next].task];
    els.seconds.min = String(d.min); els.seconds.max = String(d.max); els.seconds.step = next === 'sfx' ? '0.5' : '1';
    els.seconds.value = String(lengths[next]);
    els.promptLabel.textContent = t(`prompt.${next}`);
    els.prompt.placeholder = t(`prompt.placeholder.${next}`);
    els.promptHint.textContent = t(next === 'sfx' ? 'prompt.hintSfx' : 'prompt.hint');
    els.ideas.replaceChildren(...Object.entries(IDEAS[next]).map(([k, text]) => button('idea', t(`idea.${next}.${k}`), () => { els.prompt.value = text; els.prompt.focus(); readiness(); }, { 'data-idea': k })));
  }
  outputs();
  const labels = { run: t(`action.run.${next}`), download: t(`action.download.${next}`) };
  shell.els.primary.dataset.labelRun = labels.run;
  shell.els.primary.dataset.labelDownload = labels.download;
  // The variant is chosen at once; the store's answer (the download size) comes later.
  const asked = shell.useModel(MODES[next].model, labels);
  const say = () => { const why = blockedText(); if (why) shell.setStatus(why); readiness(); };
  say();
  await asked.then(say, () => {});
}
for (const b of els.modes) b.addEventListener('click', () => { if (!shell.busy) setMode(b.dataset.mode).catch(err => shell.showError(err)); });
const setModeNow = m => { setMode(m).catch(err => shell.showError(err)); };

// ── progress by stage ───────────────────────────────────────────────────────
const baseProgress = shell.onProgress.bind(shell);
shell.onProgress = p => {
  if (p.status !== 'running' || !p.stage) { baseProgress(p); return; }
  const bar = shell.els.progress;
  if (p.stage === 'step' || p.stage === 'chunk') {
    const [i, n] = p.stage === 'step' ? [p.step, p.steps] : [p.chunk, p.chunks];
    if (bar) { bar.hidden = false; bar.max = n; bar.value = i - 0.5; }
  } else if (bar && p.stage !== 'decode') bar.hidden = true;
  shell.setStatus(t(`stage.${p.stage}`, p));
};

// ── results ─────────────────────────────────────────────────────────────────
let shown = null; // { player, url }
function forgetShown() {
  shown?.player.dispose();
  shown = null;
  shell.clearResult();
}

async function showClip(clip, { fresh = false } = {}) {
  forgetShown();
  const { channels, sampleRate } = decodeWav(await clip.wav.arrayBuffer());
  const section = shell.showResult();
  const name = clip.mode === 'speech' ? short(clip.text || '', 60) : short(clip.prompt || '', 60);
  const player = createPlayer({ channels, sampleRate, t, name });
  shown = { player };
  const meta = clip.mode === 'speech'
    ? t('result.meta.speech', { device: shell.deviceLabel(clip.device), seconds: num(clip.seconds.toFixed(1)), voice: VOICES.find(v => v.id === clip.voice)?.name || clip.voice })
    : t('result.meta.music', { device: shell.deviceLabel(clip.device), seconds: num(clip.seconds.toFixed(1)), seed: clip.seed });
  const base = slug(clip.mode === 'speech' ? clip.text || '' : clip.prompt || '');
  const actions = el('p', { class: 'actions' },
    button('download-wav', t('download.wav'), () => shell.download(clip.wav, `${base}.wav`)));
  if (await oggReady) {
    actions.append(button('download-ogg', t('download.ogg'), async b => {
      b.disabled = true;
      try { shell.download(await encodeOgg(channels, sampleRate), `${base}.ogg`); } finally { b.disabled = false; }
    }));
  }
  if (clip.seed != null) actions.append(button('reuse-seed', t('reuse.seed'), () => { els.seed.value = String(clip.seed); els.seed.focus(); }));
  section.append(el('article', { class: 'card', 'data-role': 'clip', 'data-mode': clip.mode },
    el('h3', {}, t(`result.title.${clip.mode}`)),
    el('p', { 'data-role': 'result-meta' }, meta),
    el('p', { class: 'muted', 'data-role': 'result-what' }, short(clip.mode === 'speech' ? clip.text : clip.prompt, 240)),
    player.node,
    actions));
  actions.scrollIntoView?.({ block: 'nearest' });
  if (fresh) player.play().catch(() => {});
  return { channels };
}

// ── history ─────────────────────────────────────────────────────────────────
let clearArmed = null;
async function renderHistory() {
  const items = await history.list();
  els.historyEmpty.hidden = items.length > 0;
  els.historyTools.hidden = items.length === 0;
  els.historyNote.textContent = t('history.note', { n: LIMIT });
  els.historyList.replaceChildren(...items.map(c => el('li', { 'data-id': c.id },
    el('article', { class: 'card', 'data-mode': c.mode },
      el('span', { class: 'muted' }, t(`result.title.${c.mode}`)),
      el('span', { class: 'what' }, short(c.mode === 'speech' ? c.text || '' : c.prompt || '', 80), ' ', el('span', { class: 'muted' }, `· ${num(c.seconds.toFixed(1))} s`)),
      el('span', { class: 'tools' },
        button('history-open', t('history.load'), () => showClip(c)),
        button('history-download', t('download.wav'), () => shell.download(c.wav, `${slug(c.mode === 'speech' ? c.text || '' : c.prompt || '')}.wav`)),
        button('history-delete', t('history.delete'), async () => { await history.remove(c.id); await renderHistory(); }))))));
}
$('[data-action="clear-history"]').addEventListener('click', async e => {
  const b = e.currentTarget;
  if (!clearArmed) {
    b.textContent = t('history.confirm');
    clearArmed = setTimeout(() => { clearArmed = null; b.textContent = t('history.clear'); }, 4000);
    return;
  }
  clearTimeout(clearArmed); clearArmed = null; b.textContent = t('history.clear');
  await history.clear();
  await renderHistory();
});

// ── the primary action ──────────────────────────────────────────────────────
function inputOf(m) {
  if (m === 'speech') return { text: els.text.value, voice: els.voice.value, speed: Number(els.speed.value) };
  const seed = els.seed.value.trim() === '' ? undefined : Number(els.seed.value);
  return { prompt: els.prompt.value, seconds: Number(els.seconds.value), seed, steps: Number(els.steps.value) };
}

els.cancel.addEventListener('click', () => shell.cancel());
shell.onPrimary(async ({ signal }) => {
  const m = mode;
  const input = inputOf(m);
  // One large model at a time: music and effects each hold a whole Stable Audio model.
  for (const [k, r] of Object.entries(runners)) if (k !== m && k !== 'speech' && m !== 'speech') { await r.dispose(); delete runners[k]; }
  runners[m] ||= shell.taskRunner(o => new MODES[m].Task(o));
  forgetShown();
  els.cancel.hidden = false;
  for (const b of els.modes) b.disabled = true;
  try {
    const { result, device } = await runners[m].run(input, { signal });
    const clip = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), mode: m,
      seconds: result.seconds, sampleRate: result.sampleRate, channels: result.channels, device, model: result.model, wav: result.blob,
      ...(m === 'speech' ? { text: input.text, voice: result.voice, lang: result.lang, speed: result.speed } : { prompt: result.prompt, seed: result.seed, steps: result.steps }),
    };
    await showClip(clip, { fresh: true });
    shell.setStatus(t('status.done'));
    try { await history.add(clip); } catch { /* no room in this browser: the clip stays on screen */ }
    await renderHistory();
    if (probe) Object.assign(probe, { runs: probe.runs + 1, last: { mode: m, device, decoder: result.decoder, seconds: result.seconds, sampleRate: result.sampleRate, channels: result.channels, seed: result.seed, stats: result.stats, bytes: result.blob.size } });
  } catch (err) {
    if (probe) probe.error = `${err?.code}: ${err?.message}${err?.cause ? ' | ' + (err.cause.message || err.cause) : ''}`;
    throw err;
  } finally {
    els.cancel.hidden = true;
    for (const b of els.modes) b.disabled = false;
  }
}, { after: () => readiness() });

// Music first where it can run here; otherwise the voice, which runs everywhere.
shell.useModel(MODES.music.model).catch(() => {});
setModeNow(shell.choiceError ? 'speech' : 'music');
renderHistory().catch(() => {});
outputs();
