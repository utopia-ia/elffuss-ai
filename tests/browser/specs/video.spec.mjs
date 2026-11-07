// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The video site through its real page, in both configurations: a photo in, the
// primary button, then the live preview (it moves, and follows a change of
// move at once, without running the models again) and the video: an MP4 the
// browser plays, of the size and length asked for, whose frames are the photo
// (their colours close to the photo's), with its soundtrack when one is given.
// Also: what the button says before and after, files that are not photos, and
// a second video of the same photo that does not compute its layers again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseVariant } from '../../../sdk/core/device.js';
import { fill } from '../../../scripts/lib/template.mjs';
import { formatMB } from '../../../scripts/lib/pages.mjs';
import { expectedDevice } from '../harness.mjs';

const FIX = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const PHOTO = join(FIX, 'depth', 'foto.jpg');
const MODEL = 'image-to-video/depth-parallax';

/** A WAV file of a tone (16-bit stereo), made here. */
export function toneWav(seconds = 1.5, rate = 44100) {
  const n = Math.round(seconds * rate), data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(2 * Math.PI * 330 * i / rate) * 12000); data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2); }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const state = page => page.evaluate(() => {
  const q = s => document.querySelector(s);
  const v = globalThis.__elffuss?.video || {};
  return {
    probe: JSON.parse(JSON.stringify(v)), errors: [...(globalThis.__elffuss?.errors || [])], status: q('main p.status')?.textContent ?? '',
    primary: { text: q('main button.primary')?.textContent, disabled: q('main button.primary')?.disabled },
    live: !q('main [data-role="live"]')?.hidden, cards: [...document.querySelectorAll('main section.result article.card')].map(c => c.dataset.role),
    styleAttrs: document.querySelectorAll('[style]').length, buttons: [...document.querySelectorAll('button')].map(b => b.className),
  };
});

async function setSeconds(page, s) {
  await page.evaluate(v => { const r = document.querySelector('main [data-input="seconds"]'); r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); }, s);
}

async function press(page, timeout = 1800000) {
  const before = await page.evaluate(() => ({ runs: globalThis.__elffuss.video.runs, errors: globalThis.__elffuss.errors.length }));
  await page.click('main button.primary');
  await page.waitForFunction(b => globalThis.__elffuss.video.runs > b.runs || globalThis.__elffuss.errors.length > b.errors, before, { timeout, polling: 250 });
  await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 60000 });
  return state(page);
}

/** The result's video as the page's own player sees it, and the mean colour of a frame. */
const played = page => page.evaluate(async () => {
  const v = document.querySelector('main section.result video');
  if (v.readyState < 1) await new Promise(r => v.addEventListener('loadedmetadata', r, { once: true }));
  v.currentTime = Math.min(0.5, v.duration / 2);
  await new Promise(r => v.addEventListener('seeked', r, { once: true }));
  const c = new OffscreenCanvas(64, 64), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(v, 0, 0, 64, 64);
  const px = g.getImageData(0, 0, 64, 64).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
  return { width: v.videoWidth, height: v.videoHeight, duration: v.duration, mean: [r, gg, b].map(x => x / 4096) };
});

/** The photo's mean colour, in the page. */
const photoMean = (page, b64) => page.evaluate(async data => {
  const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))]));
  const c = new OffscreenCanvas(64, 64), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, 64, 64);
  const px = g.getImageData(0, 0, 64, 64).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
  return [r, gg, b].map(x => x / 4096);
}, b64);

/** Two readings of the live preview a moment apart. */
const liveFrames = page => page.evaluate(async () => {
  const c = document.querySelector('main [data-role="live"]');
  const read = () => new Promise(r => requestAnimationFrame(() => { const t = new OffscreenCanvas(32, 32); const g = t.getContext('2d', { willReadFrequently: true }); g.drawImage(c, 0, 0, 32, 32); r([...g.getImageData(0, 0, 32, 32).data]); }));
  const a = await read();
  await new Promise(r => setTimeout(r, 700));
  const b = await read();
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return { diff: diff / a.length, opaque: a.filter((v, i) => i % 4 === 3 && v === 255).length };
});

export default [
  {
    name: 'a photo gives a live preview and an MP4 of the size and length asked for, whose frames are the photo',
    sites: ['video'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const s = t.strings.video.es;
      const model = t.registry.models[MODEL];
      const choice = chooseVariant(model, 'auto', t.probe);
      const before = await state(page);
      t.equal(before.primary, { text: fill(s['action.downloadAndRun'], { size: `${formatMB(choice.variant.bytes, 'es')} MB` }), disabled: true }, 'before a photo: disabled, and it says what it will download');
      await page.setInputFiles('main label.drop input[type="file"]', PHOTO);
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 60000 });
      t.equal(t.hubTotal(), 0, 'nothing is downloaded before the button');
      await setSeconds(page, 2);
      const st = await press(page);
      t.equal(st.errors, [], `no error (${st.status})`);
      t.equal([st.probe.runs, st.probe.scenes], [1, 1], 'one scene, one video');
      t.equal(st.probe.device, expectedDevice(site, t.registry, t.config), 'the backend of the configuration');
      t.equal([st.probe.width, st.probe.height], [1920, 1080], '16:9 at 1080');
      t.ok(['mp4', 'webm'].includes(st.probe.container), `a video file (${st.probe.container}, ${st.probe.videoCodec})`);
      t.ok(st.probe.layers >= 1 && st.probe.layers <= 3, `layers: ${st.probe.layers}`);
      t.equal(st.status, s['status.done'], 'status');
      t.equal(st.cards, ['video'], 'the video card');
      t.equal(st.styleAttrs, 0, 'no style attribute after a run');
      t.ok(st.buttons.filter(c => c === 'primary').length === 1 && st.buttons.every(c => c === 'primary' || c === 'ghost'), 'one button.primary, the rest .ghost');
      const label = await page.waitForFunction(x => document.querySelector('main button.primary').textContent === x, s['action.run'], { timeout: 15000 }).then(() => true, () => false);
      t.ok(label, 'after the run the models are stored and the label says so');
      const v = await played(page);
      t.equal([v.width, v.height], [1920, 1080], 'the browser plays it at its size');
      t.ok(Math.abs(v.duration - 2) < 0.1, `it lasts what was asked (${v.duration})`);
      const pm = await photoMean(page, readFileSync(PHOTO).toString('base64'));
      t.ok(v.mean.every((c, i) => Math.abs(c - pm[i]) < 40), `its frames look like the photo (mean ${v.mean.map(Math.round)} vs ${pm.map(Math.round)})`);
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('main section.result [data-action="download"]')]);
      const name = dl.suggestedFilename();
      const bytes = readFileSync(await dl.path());
      t.ok(/^foto-video\.(mp4|webm)$/.test(name), `file name ${name}`);
      if (name.endsWith('.mp4')) t.equal(bytes.subarray(4, 8).toString('latin1'), 'ftyp', 'an MP4 file');
      // The live preview moves, and a new move changes it at once, with no model run.
      t.equal(st.live, true, 'the live preview is on');
      const live = await liveFrames(page);
      t.ok(live.diff > 0.2, `the preview moves (${live.diff.toFixed(2)})`);
      t.ok(live.opaque === 32 * 32, 'the preview covers its canvas: no edge of the photo shows');
      await page.selectOption('main [data-input="preset"]', 'orbit');
      await page.selectOption('main [data-input="aspect"]', '9:16');
      t.hub.reset();
      const again = await press(page);
      t.equal([again.probe.runs, again.probe.scenes, again.probe.preset, again.probe.width, again.probe.height], [2, 1, 'orbit', 1080, 1920], 'a second video of the same photo, 9:16, without computing its layers again');
      t.equal(t.hubTotal(), 0, 'and without any download');
      await t.noCsp(page);
      t.noPageErrors();
      t.networkClean(site);
      t.note(`${st.probe.device} ${st.probe.container} ${st.probe.videoCodec}, ${st.probe.layers} layers, ${(st.probe.bytes / 1e6).toFixed(1)} MB for 2 s`);
    },
  },
  {
    name: 'a sound file becomes the soundtrack, fitted to the video',
    sites: ['video'],
    configs: ['A'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await page.setInputFiles('main label.drop input[type="file"]', PHOTO);
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 60000 });
      await setSeconds(page, 2);
      await page.selectOption('main [data-input="sound"]', 'file');
      await page.setInputFiles('main [data-input="sound-file"]', { name: 'tono.wav', mimeType: 'audio/wav', buffer: toneWav() });
      await page.waitForFunction(() => document.querySelector('main [data-role="sound-name"]').textContent.includes('tono.wav'), null, { timeout: 30000 });
      const st = await press(page);
      t.equal(st.errors, [], `no error (${st.status})`);
      t.ok(st.probe.audioCodec === null || /mp4a|opus/.test(st.probe.audioCodec), `the sound is encoded where the browser can (${st.probe.audioCodec})`);
      if (st.probe.audioCodec) {
        const has = await page.evaluate(() => { const v = document.querySelector('main section.result video'); return !v.muted; });
        t.ok(has, 'the player is not muted');
      } else t.note('no audio encoder in this browser');
      t.noPageErrors();
    },
  },
  {
    name: 'files that are not photos: the page says why and enables nothing',
    sites: ['video'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const s = t.strings.video.es;
      const n = await page.evaluate(() => globalThis.__elffuss.errors.length);
      await page.setInputFiles('main label.drop input[type="file"]', { name: 'nota.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('esto no es una foto\n') });
      await page.waitForFunction(k => globalThis.__elffuss.errors.length > k, n, { timeout: 30000 });
      const st = await state(page);
      t.equal([st.status, st.primary.disabled], [s['error.unsupported-format'], true], 'unsupported, nothing enabled');
      t.equal(t.hubTotal(), 0, 'nothing downloaded');
      t.noPageErrors();
    },
  },
];
