// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The audio site through its real page, validating what it makes and not only
// that it loads. Every clip is downloaded from the page and measured here:
//  - its format: 16-bit WAV, 44 100 Hz stereo (music, effects) or 24 000 Hz mono
//    (speech), of the length asked (music and effects) or of a plausible length
//    for the text (speech);
//  - that it is sound: no sample at full scale, peak under -0.1 dBFS, loud enough
//    (RMS over MIN_RMS_DB), mostly not silence, and a spectrum where it should be
//    (music and effects: most energy between 40 Hz and 10 kHz; speech: in the
//    voice band, with the pauses a sentence has);
//  - that the seed reproduces: the same prompt and seed give the same clip again
//    (the decoder adds a little noise of its own, so "the same" is a high
//    correlation, MIN_SEED_CORR);
// and around it: the primary button's label before and after (download size, then
// the action), the backend reported, the history kept after a reload, the clear
// message without WebGPU for music and effects while speech still works, and the
// network and CSP rules of every page.
//
// ELFFUSS_AI_AUDIO_SAVE=<dir> keeps every clip there for listening.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from '../../../sdk/audio/wav.js';
import { measure } from '../../../sdk/audio/signal.js';

const T = 15 * 60 * 1000;
/** Thresholds, from the clips measured in Chrome with WebGPU (see the report of each run). */
export const MIN_RMS_DB = -40;
export const MAX_SILENT = 0.5;
export const MIN_SEED_CORR = 0.9;

/** Share of a clip's energy between lo and hi Hz (mono mix, Hann windows of 4096). */
export function bandShare(channels, rate, lo, hi) {
  const N = 4096, mono = channels.length === 1 ? channels[0] : channels[0].map((v, i) => (v + channels[1][i]) / 2);
  let inBand = 0, total = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let at = 0; at + N <= mono.length; at += N * 2) {
    for (let i = 0; i < N; i++) { re[i] = mono[at + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const e = re[k] * re[k] + im[k] * im[k], f = (k * rate) / N;
      total += e;
      if (f >= lo && f < hi) inBand += e;
    }
  }
  return total ? inBand / total : 0;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci, vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/** Correlation of the first channel of two clips over their common length. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; c += x * y; va += x * x; vb += y * y; }
  return va && vb ? c / Math.sqrt(va * vb) : 0;
}

const save = (name, buf) => {
  const dir = process.env.ELFFUSS_AI_AUDIO_SAVE;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), buf);
};

async function setMode(page, mode) {
  await page.click(`.modes [data-mode="${mode}"]`);
  await page.waitForFunction(m => document.querySelector(`.modes [data-mode="${m}"]`).getAttribute('aria-pressed') === 'true', mode);
}

/** Run the primary action and wait for its clip; returns the downloaded WAV and what the page measured. */
async function generate(t, page) {
  const before = await page.evaluate(() => [globalThis.__elffuss.audio.runs, globalThis.__elffuss.errors.length]);
  await page.click('main button.primary');
  await page.waitForFunction(([n, e]) => globalThis.__elffuss.audio.runs > n || globalThis.__elffuss.errors.length > e, before, { timeout: T, polling: 1000 });
  const errors = await page.evaluate(e => globalThis.__elffuss.errors.slice(e), before[1]);
  if (errors.length) throw new Error(`the page showed errors: ${errors.join(', ')} · ${await page.textContent('main p.status')} · ${await page.evaluate(() => globalThis.__elffuss.audio.error)}`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('section.result [data-action="download-wav"]')]);
  const buf = readFileSync(await download.path());
  const last = await page.evaluate(() => globalThis.__elffuss.audio.last);
  return { buf, wav: decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), last };
}

function checkSound(t, label, wav, { rate, channels, seconds, band }) {
  t.equal(wav.sampleRate, rate, `${label}: sample rate`);
  t.equal(wav.channels.length, channels, `${label}: channels`);
  const m = measure(wav.channels, wav.sampleRate);
  if (seconds) t.ok(Math.abs(m.seconds - seconds) < 0.05, `${label}: ${m.seconds} s, asked ${seconds}`);
  t.ok(m.clipped === 0, `${label}: ${m.clipped} of the samples at full scale`);
  t.ok(m.peakDb < -0.1, `${label}: peak ${m.peakDb.toFixed(2)} dBFS`);
  t.ok(m.rmsDb > MIN_RMS_DB, `${label}: RMS ${m.rmsDb.toFixed(1)} dBFS`);
  // A one-shot of a couple of seconds is mostly its own decay: silence is measured on longer clips.
  if (m.seconds >= 4) t.ok(m.silent < MAX_SILENT, `${label}: ${(m.silent * 100).toFixed(0)} % silent`);
  const share = bandShare(wav.channels, wav.sampleRate, band[0], band[1]);
  t.ok(share > 0.8, `${label}: ${(share * 100).toFixed(1)} % of the energy in ${band[0]}–${band[1]} Hz`);
  t.note(`${label}: ${m.seconds.toFixed(2)} s, peak ${m.peakDb.toFixed(1)} dBFS, RMS ${m.rmsDb.toFixed(1)} dBFS, silent ${(m.silent * 100).toFixed(0)} %, in band ${(share * 100).toFixed(0)} %`);
  return m;
}

/** The Spanish sentences of the voice's reference listening set: [name, text, shortest s, longest s]. */
export const MOSS_SENTENCES = [
  ['A', 'Hola, soy Elffuss. Hoy hace un día estupendo en Zaragoza: vamos a cocinar una paella con cebolla, ajo y azafrán. ¿Te apetece probarla?', 5, 16],
  ['B', 'Cuando quieras, te cuento un cuento antes de dormir. Había una vez una ciudad pequeña junto al mar, donde las gaviotas cantaban al amanecer.', 6, 16],
  ['C', 'Gracias por venir. ¿Te hace un zumo de naranja o prefieres un café con azúcar? Cerca de aquí hay una plaza preciosa.', 5, 15],
];

/** Prompts of the opt-in quality set (ELFFUSS_AI_AUDIO_QUALITY=1): [mode, name, prompt, seconds, steps]. */
export const QUALITY_SET = [
  ['music', 'lofi', 'Lo-fi hip hop beat with mellow Rhodes chords, soft vinyl crackle, brushed drums and a warm upright bass, 80 BPM', 30, 8],
  ['music', 'lofi-12', 'Lo-fi hip hop beat with mellow Rhodes chords, soft vinyl crackle, brushed drums and a warm upright bass, 80 BPM', 30, 12],
  ['music', 'orchestral', 'Epic cinematic orchestral piece with soaring strings, bold French horns, choir and thunderous taiko drums, 110 BPM', 30, 8],
  ['music', 'house', 'Deep house groove with a four-to-the-floor kick, warm sub bass, airy pads and soulful chord stabs, 122 BPM', 30, 8],
  ['music', 'guitar', 'TrackType: Instrument, a gentle solo acoustic guitar with delicate finger picking and a warm room reverb', 20, 8],
  ['music', 'es-prompt', 'Música flamenca con guitarra española, palmas y cajón, alegre, 120 BPM', 20, 8],
  ['sfx', 'rain', 'TrackType: SFX, heavy rain falling on a tin roof with distant rolling thunder', 10, 8],
  ['sfx', 'steps', 'TrackType: SFX, slow footsteps crunching on fresh snow, close microphone', 6, 8],
  ['sfx', 'laser', 'TrackType: SFX, a sci-fi laser blast with a bright attack and a short metallic tail', 2, 8],
  ['sfx', 'laser-12', 'TrackType: SFX, a sci-fi laser blast with a bright attack and a short metallic tail', 2, 12],
];

export default [
  {
    name: 'music: the label names the download, a seeded clip is sound, the same seed gives it again, the history keeps it',
    sites: ['audio'],
    configs: ['A'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const label = await page.textContent('main button.primary');
      t.ok(/Descargar el modelo \(1[.,]8 GB|Descargar el modelo \(17\d\d MB\)/.test(label), `first label: ${label}`);
      await page.fill('[data-input="prompt"]', 'Lo-fi hip hop beat with mellow Rhodes chords, soft vinyl crackle and a warm upright bass, 80 BPM');
      await page.fill('[data-input="seconds"]', '8');
      await page.dispatchEvent('[data-input="seconds"]', 'input');
      await page.fill('[data-input="seed"]', '7');
      const a = await generate(t, page);
      save('music-lofi-seed7-a.wav', a.buf);
      t.equal(a.last.device, 'webgpu', 'backend');
      t.equal(a.last.seed, 7, 'seed given back');
      checkSound(t, 'music', a.wav, { rate: 44100, channels: 2, seconds: 8, band: [40, 10000] });
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled && /^Generar la música$/.test(document.querySelector('main button.primary').textContent), null, { timeout: 60000 });
      const b = await generate(t, page);
      save('music-lofi-seed7-b.wav', b.buf);
      const r = correlation(a.wav.channels[0], b.wav.channels[0]);
      t.ok(r > MIN_SEED_CORR, `same seed, correlation ${r.toFixed(4)}`);
      t.note(`same seed correlation ${r.toFixed(4)}`);
      t.equal(await page.locator('[data-role="history-list"] > li').count(), 2, 'two clips in the history');
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('[data-role="history-list"] > li').length === 2, null, { timeout: 30000 });
      t.noPageErrors();
      await t.noCsp(page);
      t.networkClean(site);
    },
  },
  {
    name: 'sound effects: a short clip, sound and not silence',
    sites: ['audio'],
    configs: ['A'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/en/');
      await setMode(page, 'sfx');
      await page.fill('[data-input="prompt"]', 'TrackType: SFX, a heavy wooden door creaking open slowly, then slamming shut in a stone hallway');
      await page.fill('[data-input="seconds"]', '5');
      await page.dispatchEvent('[data-input="seconds"]', 'input');
      await page.fill('[data-input="seed"]', '11');
      const a = await generate(t, page);
      save('sfx-door-seed11.wav', a.buf);
      t.equal(a.last.device, 'webgpu', 'backend');
      checkSound(t, 'sfx', a.wav, { rate: 44100, channels: 2, seconds: 5, band: [40, 12000] });
      t.noPageErrors();
      await t.noCsp(page);
      t.networkClean(site);
    },
  },
  {
    name: 'speech in Spanish with Elffuss\'s own voice (MOSS-TTS-Nano, WebAssembly): sentences A, B and C, sound and of a plausible length',
    sites: ['audio'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await setMode(page, 'speech');
      t.equal(await page.inputValue('[data-input="voice"]'), 'es_elffuss', 'the Spanish page offers Elffuss\'s own voice first');
      t.ok(await page.isDisabled('[data-input="speed"]'), 'speed is Kokoro\'s: off for this voice');
      const label = await page.textContent('main button.primary');
      t.ok(/\(7[01]\d MB\)/.test(label), `first label names MOSS-TTS-Nano's download: ${label}`);
      for (const [k, text, min, max] of MOSS_SENTENCES) {
        await page.fill('[data-input="text"]', text);
        const c = await generate(t, page);
        save(`browser-mossnano-design-${k}-${t.config}.wav`, c.buf);
        t.equal(c.last.device, 'wasm', `${k}: backend`);
        const m = checkSound(t, `speech es ${k}`, c.wav, { rate: 48000, channels: 1, band: [80, 8000] });
        t.ok(m.seconds > min && m.seconds < max, `speech es ${k}: ${m.seconds} s`);
      }
      t.equal(t.hubFull().filter(u => /Kokoro|misaki|stable-audio|moss_audio_tokenizer_encode/.test(u)).length, 0, 'only MOSS-TTS-Nano\'s files were asked for (no encoder: the voice is shipped as codes)');
      t.noPageErrors();
      await t.noCsp(page);
      t.networkClean(site);
    },
  },
  {
    name: 'speech with Kokoro\'s voices in Spanish and English: long text read in chunks, joined without clicks',
    sites: ['audio'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await setMode(page, 'speech');
      await page.fill('[data-input="text"]', 'Hola. Esta voz se genera en tu navegador, sin enviar nada a ningún servidor. El modelo se descarga una vez y se guarda aquí; después funciona aunque no tengas conexión. ¿A que suena natural?');
      await page.selectOption('[data-input="voice"]', 'ef_dora');
      t.ok(!(await page.isDisabled('[data-input="speed"]')), 'speed on for a Kokoro voice');
      const es = await generate(t, page);
      save(`speech-es-dora-${t.config}.wav`, es.buf);
      t.equal(es.last.device, t.config === 'A' ? 'webgpu' : 'wasm', 'backend');
      const m = checkSound(t, 'speech es', es.wav, { rate: 24000, channels: 1, band: [80, 8000] });
      t.ok(m.seconds > 8 && m.seconds < 30, `speech es: ${m.seconds} s for four sentences`);
      let jump = 0;
      const s = es.wav.channels[0];
      for (let i = 1; i < s.length; i++) jump = Math.max(jump, Math.abs(s[i] - s[i - 1]));
      t.ok(jump < 0.6, `speech es: largest step between samples ${jump.toFixed(3)}`);
      await page.selectOption('[data-input="voice"]', 'af_heart');
      await page.fill('[data-input="text"]', 'Hello! This voice is made in your browser. Nothing is sent to a server, and it works offline once the model is here.');
      const en = await generate(t, page);
      save(`speech-en-heart-${t.config}.wav`, en.buf);
      const me = checkSound(t, 'speech en', en.wav, { rate: 24000, channels: 1, band: [80, 8000] });
      t.ok(me.seconds > 4 && me.seconds < 20, `speech en: ${me.seconds} s`);
      t.noPageErrors();
      await t.noCsp(page);
      t.networkClean(site);
    },
  },
  {
    name: 'without WebGPU, music and effects say why and stay off; nothing is downloaded for them',
    sites: ['audio'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      t.equal(await page.getAttribute('.modes [data-mode="speech"]', 'aria-pressed'), 'true', 'the page opens on the voice, which runs here');
      await setMode(page, 'music');
      await page.fill('[data-input="prompt"]', 'Lo-fi hip hop');
      t.ok(await page.isDisabled('main button.primary'), 'the primary button stays off');
      t.ok(/WebGPU/.test(await page.textContent('main p.status')), `status: ${await page.textContent('main p.status')}`);
      await setMode(page, 'sfx');
      t.ok(await page.isDisabled('main button.primary'), 'off for effects too');
      await setMode(page, 'speech');
      await page.fill('[data-input="text"]', 'Hola');
      t.ok(!(await page.isDisabled('main button.primary')), 'speech can run');
      t.equal(t.hubFull().filter(u => /stable-audio/.test(u)).length, 0, 'no Stable Audio file was asked for');
      t.noPageErrors();
      await t.noCsp(page);
    },
  },
  {
    name: 'quality set (ELFFUSS_AI_AUDIO_QUALITY=1): clips of several prompts and step counts, measured and kept',
    sites: ['audio'],
    configs: ['A'],
    async run(t, site) {
      if (process.env.ELFFUSS_AI_AUDIO_QUALITY !== '1') { t.note('not run: set ELFFUSS_AI_AUDIO_QUALITY=1'); return; }
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/en/');
      for (const [mode, name, prompt, seconds, steps] of QUALITY_SET) {
        await setMode(page, mode);
        await page.fill('[data-input="prompt"]', prompt);
        await page.fill('[data-input="seconds"]', String(seconds));
        await page.dispatchEvent('[data-input="seconds"]', 'input');
        await page.fill('[data-input="seed"]', '42');
        if (!(await page.getAttribute('details.advanced', 'open') !== null)) await page.click('details.advanced > summary');
        await page.fill('[data-input="steps"]', String(steps));
        await page.dispatchEvent('[data-input="steps"]', 'input');
        await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: T });
        const c = await generate(t, page);
        save(`q-${mode}-${name}-s42.wav`, c.buf);
        checkSound(t, `${mode} ${name}`, c.wav, { rate: 44100, channels: 2, seconds, band: [30, 16000] });
      }
      t.noPageErrors();
    },
  },
];
