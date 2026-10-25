// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The catalog: every tool with a link to its own host, also without JavaScript,
// the Elffuss apps, and the mark on the tool whose model this browser already has.
export default [
  {
    name: 'lists every tool and app with its link, also without JavaScript',
    sites: ['tools'],
    async run(t, site) {
      for (const js of [true, false]) {
        const ctx = await t.newContext({ javaScriptEnabled: js });
        const page = await t.open(ctx, site, '/', { wait: js ? 'shell' : 'load' });
        const cards = await page.evaluate(() => [...document.querySelectorAll('article.card')].map(c => ({ site: c.dataset.site || null, app: c.dataset.app || null, href: c.querySelector('h3 a')?.getAttribute('href') })));
        for (const s of t.sites.filter(x => !x.catalog)) {
          const c = cards.find(x => x.site === s.site);
          t.ok(c && c.href === t.url(s, '/'), `${js ? 'with' : 'without'} JavaScript: ${s.site} links to its host (${c?.href})`);
        }
        for (const id of ['claw', 'code', 'translator', 'copilot']) t.ok(cards.some(c => c.app === id && /^https:\/\/[a-z]+\.elffuss\.com$/.test(c.href)), `${id} card`);
        await ctx.close();
      }
      t.noPageErrors();
    },
  },
  {
    name: 'marks the tool whose model is already in this browser, and no other',
    sites: ['tools'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const depth = t.sites.find(s => s.site === 'depth');
      const p = await t.open(ctx, depth, '/__test__/core.html', { wait: 'smoke' });
      t.ok(!(await t.smoke(p)).error, 'depth stores its model');
      const page = await t.open(ctx, site, '/');
      const marks = await page.evaluate(() => globalThis.__elffuss?.marks);
      t.equal(marks, { cutout: false, depth: true, detect: false, ocr: false }, 'marks');
      const shown = await page.evaluate(() => [...document.querySelectorAll('article.card[data-site]')].filter(c => !c.querySelector('[data-role="stored"]').hidden).map(c => c.dataset.site));
      t.equal(shown, ['depth'], 'only the depth card says it is already here');
      await t.noCsp(page);
      t.networkClean(site, { extra: [new URL(t.url(depth)).origin] });
    },
  },
];
