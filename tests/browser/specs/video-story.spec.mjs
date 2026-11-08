// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The third mode of the video site, a video that does what it is asked (a storyboard:
// SANA-Sprint keyframes, Wan 2.1 VACE clips between them), through the real page: offered
// only where WebGPU gives an adapter and the site lists the storyboard model; before
// anything is downloaded it says whether this device can make it; then a 3 s story: the
// keyframe cards fill in (a step preview first), the page asks "Continue" / "Change" with a
// countdown, the clip slot fills step by step and plays, the timeline segment is done, and
// the video is a file the browser plays; only the files of that model are asked of the Hub.
// Until the model is published and listed by the site (apps/video/app.json, third model),
// the spec says so and stops.
import { readFileSync } from 'node:fs';
import { variantFiles } from '../../../sdk/core/registry.js';

const MODEL = 'text-to-video/wan2.1-vace-1.3b-rcm';

const state = page => page.evaluate(() => {
  const q = s => document.querySelector(s);
  const all = s => [...document.querySelectorAll(s)];
  const v = globalThis.__elffuss?.video || {};
  return {
    probe: JSON.parse(JSON.stringify(v)), errors: [...(globalThis.__elffuss?.errors || [])], status: q('main p.status')?.textContent ?? '',
    primary: { text: q('main button.primary')?.textContent, disabled: q('main button.primary')?.disabled },
    storyMode: !q('main [data-role="mode-story"]')?.hidden, story: !q('main [data-role="story-settings"]')?.hidden,
    drop: !q('main label.drop')?.hidden, gate: q('main [data-role="story-gate"]')?.textContent ?? '',
    cards: all('main [data-role="board"] li.card').map(c => c.className), slots: all('main [data-role="board"] li.slot').map(c => c.className),
    segs: all('main [data-role="timeline"] .seg').map(b => b.className), slotVideos: all('main [data-role="board"] li.slot video').length,
    result: all('main section.result article.card').map(c => c.dataset.role), styleAttrs: document.querySelectorAll('[style]').length,
  };
});

const listed = (t, site) => {
  try { return JSON.parse(readFileSync(new URL(`../../../apps/${site.site}/app.json`, import.meta.url), 'utf8')).models?.includes(MODEL); } catch { return false; }
};

export default [
  {
    name: 'a story: offered with WebGPU, says what it downloads, keyframes, a pause to look, then the clip and the video',
    sites: ['video'],
    configs: ['A'],
    timeout: 45 * 60 * 1000,
    async run(t, site) {
      if (!t.registry.models[MODEL] || !listed(t, site)) { t.note(`${MODEL} is not published and listed by the site yet: nothing to test`); return; }
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const model = t.registry.models[MODEL];
      const files = variantFiles(model, model.devices.webgpu[0]);
      await page.waitForFunction(() => globalThis.__elffuss?.video?.storyMode === true, null, { timeout: 30000 });
      await page.check('main [data-input="mode"][value="story"]');
      await page.waitForFunction(() => globalThis.__elffuss.video.storyEstimate, null, { timeout: 60000 });
      const before = await state(page);
      t.equal([before.story, before.drop], [true, false], 'the story settings replace the photo');
      t.ok(before.primary.disabled, 'without a description: off');
      t.equal(t.hubTotal(), 0, 'nothing is downloaded to say what it needs');
      if (!before.probe.storyEstimate.fits) {
        t.note(`this device cannot make it: ${before.probe.storyEstimate.reason} (${before.gate})`);
        t.ok(before.gate.length > 0, 'and the page says why');
        return;
      }
      await page.fill('main [data-input="story-prompt"]', 'a red fox sits in the snow, then it looks at the camera');
      await page.selectOption('main [data-input="story-seconds"]', '3');
      await page.selectOption('main [data-input="story-size"]', '624x624');
      await page.evaluate(() => { for (const d of document.querySelectorAll('main details.advanced')) d.open = true; }); // the expert settings are folded (a visual change only)
      await page.fill('main [data-input="story-seed"]', '7');
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 60000 });
      await page.click('main button.primary');
      // the keyframes: two cards, each with its step preview, then the question (or an error: then stop)
      await page.waitForFunction(() => document.querySelector('main [data-action="story-continue"]') || globalThis.__elffuss.errors.length > 0, null, { timeout: 20 * 60000, polling: 1000 });
      const look = await state(page);
      if (look.errors.length) { t.equal(look.errors, [], `no error before the keyframes are shown (${look.status})`); return; }
      t.equal(look.cards, ['card ready', 'card ready'], 'both keyframes painted');
      t.equal(look.slots.length, 1, 'one clip slot between them');
      t.ok((look.probe.stages || []).includes('keyframe'), 'keyframe progress reported');
      await page.click('main [data-action="story-continue"]');
      await page.waitForFunction(() => globalThis.__elffuss.video.story?.runs >= 1 || globalThis.__elffuss.errors.length > 0, null, { timeout: 30 * 60000, polling: 1000 });
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 120000 });
      const st = await state(page);
      t.equal(st.errors, [], `no error (${st.status})`);
      const r = st.probe.story || {};
      t.equal([r.width, r.height, r.seed, r.clips], [624, 624, 7, 1], 'the size, seed and clips asked for');
      t.ok(r.frames >= 45 && r.frames <= 53, `about 3 s at 16 fps (${r.frames} frames)`);
      t.equal(st.slots, ['slot ready'], 'the clip slot is done');
      t.equal(st.slotVideos, 1, 'and plays its clip');
      t.equal(st.segs, ['seg ready'], 'the timeline segment is done');
      t.ok((st.probe.stages || []).includes('clip'), 'clip steps reported');
      t.equal(st.result, ['video'], 'the video card');
      t.equal(st.styleAttrs, 0, 'no style attribute after a run');
      t.hubOnly(files.map(f => f.url), 'the storyboard model');
      const v = await page.evaluate(async () => {
        const el = document.querySelector('main section.result video');
        if (el.readyState < 1) await new Promise(res => el.addEventListener('loadedmetadata', res, { once: true }));
        return { width: el.videoWidth, height: el.videoHeight, duration: el.duration };
      });
      t.equal([v.width, v.height], [624, 624], 'the browser plays it at its size');
      t.ok(v.duration > 2.5 && v.duration < 3.6, `about 3 s (${v.duration.toFixed(2)} s)`);
      await t.noCsp(page);
      t.noPageErrors();
      t.networkClean(site);
      t.note(`${r.mime}, ${(r.bytes / 1e6).toFixed(2)} MB, ${r.frames} frames`);
    },
  },
  {
    name: 'a story: not offered without WebGPU',
    sites: ['video'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await page.waitForTimeout(1500);
      const st = await state(page);
      t.equal([st.storyMode, st.story, st.drop], [false, false, true], 'only the photo mode');
      t.equal(t.hubTotal(), 0, 'nothing downloaded');
      await t.noCsp(page);
      t.noPageErrors();
    },
  },
];
