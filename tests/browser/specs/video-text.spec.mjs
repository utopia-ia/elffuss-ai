// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The second mode of the video site, a video from a text (Wan 2.1 T2V 1.3B),
// through the real page: offered only where WebGPU gives an adapter; before
// anything is downloaded it says whether this device can make it and what it
// will download; then a short video from a description, stage by stage, as a
// file the browser plays, with only the files of that model asked of the Hub.
// Back on the photo, the page is the photo mode again.
import { readFileSync } from 'node:fs';
import { variantFiles } from '../../../sdk/core/registry.js';
import { chooseVariant } from '../../../sdk/core/device.js';
import { fill } from '../../../scripts/lib/template.mjs';
import { formatSize } from '../../../scripts/lib/pages.mjs';

const MODEL = 'text-to-video/wan2.1-t2v-1.3b-rcm';
const PHOTO_MODEL = 'image-to-video/depth-parallax';

const state = page => page.evaluate(() => {
  const q = s => document.querySelector(s);
  const v = globalThis.__elffuss?.video || {};
  return {
    probe: JSON.parse(JSON.stringify(v)), errors: [...(globalThis.__elffuss?.errors || [])], status: q('main p.status')?.textContent ?? '',
    primary: { text: q('main button.primary')?.textContent, disabled: q('main button.primary')?.disabled },
    modes: !q('main [data-role="modes"]')?.hidden, text: !q('main [data-role="text-settings"]')?.hidden,
    drop: !q('main label.drop')?.hidden, settings: !q('main [data-role="settings"]')?.hidden,
    gate: q('main [data-role="text-gate"]')?.textContent ?? '', cards: [...document.querySelectorAll('main section.result article.card')].map(c => c.dataset.role),
    styleAttrs: document.querySelectorAll('[style]').length,
  };
});

export default [
  {
    name: 'from a text: offered with WebGPU, says what it downloads, then a short video from a description',
    sites: ['video'],
    configs: ['A'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const s = t.strings.video.es;
      const model = t.registry.models[MODEL];
      const files = variantFiles(model, model.devices.webgpu[0]);
      const size = formatSize(model.devices.webgpu[0].bytes, 'es');
      await page.waitForFunction(() => globalThis.__elffuss?.video?.modes === true, null, { timeout: 30000 });
      await page.check('main [data-input="mode"][value="text"]');
      await page.waitForFunction(() => globalThis.__elffuss.video.estimate, null, { timeout: 60000 });
      const before = await state(page);
      t.equal([before.text, before.drop, before.settings], [true, false, false], 'the text settings replace the photo and its camera');
      t.equal(before.primary, { text: fill(s['action.downloadAndRun'], { size }), disabled: true }, 'without a description: off, and it says what it will download');
      t.equal(t.hubTotal(), 0, 'nothing is downloaded to say so');
      if (!before.probe.estimate.fits) {
        t.note(`this device cannot make it: ${before.probe.estimate.reason} (${before.gate})`);
        t.ok(before.gate.length > 0, 'and the page says why');
        return;
      }
      await page.fill('main [data-input="prompt"]', 'a red fox running through the snow, cinematic');
      await page.selectOption('main [data-input="size"]', '640x368');
      await page.selectOption('main [data-input="gen-seconds"]', '1');
      await page.evaluate(() => { for (const d of document.querySelectorAll('main details.advanced')) d.open = true; }); // the expert settings are folded (a visual change only)
      await page.selectOption('main [data-input="steps"]', '2');
      await page.fill('main [data-input="seed"]', '7');
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 60000 });
      await page.click('main button.primary');
      await page.waitForFunction(() => globalThis.__elffuss.video.text?.runs >= 1 || globalThis.__elffuss.errors.length > 0, null, { timeout: 3600000, polling: 1000 });
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 120000 });
      const st = await state(page);
      t.equal(st.errors, [], `no error (${st.status})`);
      const r = st.probe.text || {};
      t.equal([r.width, r.height, r.seed, r.steps], [640, 368, 7, 2], 'the size, seed and steps asked for');
      t.ok(r.frames >= 13 && r.frames <= 21, `about a second at 16 fps (${r.frames} frames)`);
      t.equal([...new Set(st.probe.stages || [])], ['encode', 'load', 'step', 'decode', 'mux'], 'the stages, in order');
      t.equal(st.cards, ['video'], 'the video card');
      t.equal(st.styleAttrs, 0, 'no style attribute after a run');
      t.hubOnly(files.map(f => f.url), 'the text model');
      const label = await page.waitForFunction(x => document.querySelector('main button.primary').textContent === x, s['action.run'], { timeout: 30000 }).then(() => true, () => false);
      t.ok(label, 'after the run the model is stored and the label says so');
      const v = await page.evaluate(async () => {
        const el = document.querySelector('main section.result video');
        if (el.readyState < 1) await new Promise(res => el.addEventListener('loadedmetadata', res, { once: true }));
        return { width: el.videoWidth, height: el.videoHeight, duration: el.duration };
      });
      t.equal([v.width, v.height], [640, 368], 'the browser plays it at its size');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('main section.result [data-action="download"]')]);
      const name = dl.suggestedFilename();
      t.ok(/^video-texto-7\.(mp4|webm)$/.test(name), `file name ${name}`);
      if (name.endsWith('.mp4')) t.equal(readFileSync(await dl.path()).subarray(4, 8).toString('latin1'), 'ftyp', 'an MP4 file');
      // Back to the photo: its settings, its drop zone and its own model's label.
      await page.check('main [data-input="mode"][value="image"]');
      const photo = t.registry.models[PHOTO_MODEL];
      await page.waitForFunction(() => globalThis.__elffuss.video.mode === 'image', null, { timeout: 10000 });
      const back = await state(page);
      t.equal([back.text, back.drop, back.settings, back.cards], [false, true, true, []], 'the photo mode, without the text result');
      t.ok(back.primary.disabled, 'off until a photo is chosen');
      const photoSize = formatSize(chooseVariant(photo, 'auto', t.probe).variant.bytes, 'es');
      t.equal(back.primary.text, fill(s['action.downloadAndRun'], { size: photoSize }), 'the label is the photo model\'s again');
      await t.noCsp(page);
      t.noPageErrors();
      t.networkClean(site);
      t.note(`${r.mime}, ${(r.bytes / 1e6).toFixed(2)} MB, ${r.frames} frames`);
    },
  },
  {
    name: 'from a text: not offered without WebGPU',
    sites: ['video'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await page.waitForTimeout(1500);
      const st = await state(page);
      t.equal([st.modes, st.text, st.drop], [false, false, true], 'only the photo mode');
      t.equal(t.hubTotal(), 0, 'nothing downloaded');
      await t.noCsp(page);
      t.noPageErrors();
    },
  },
];
