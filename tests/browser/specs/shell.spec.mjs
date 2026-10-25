// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What every site must do before any model runs, in both configurations: load
// without errors or CSP violations in /, /en/ and the licence pages; keep the
// markup contract (header, main, footer, one primary button, no inline styles or
// scripts); credit the model as the registry says; ask the store what it has
// and label the primary button with what is left to download; and, without the
// store, say so and never reach the Hub.
import { chooseVariant } from '../../../sdk/core/device.js';
import { fill } from '../../../scripts/lib/template.mjs';
import { formatMB } from '../../../scripts/lib/pages.mjs';

/** Facts of the current page, read in the browser. */
export function pageFacts(page) {
  return page.evaluate(() => {
    const q = s => document.querySelector(s);
    const all = s => [...document.querySelectorAll(s)];
    return {
      lang: document.documentElement.lang,
      title: document.title,
      brand: q('header a.brand')?.textContent ?? null,
      nav: all('header nav a').map(a => ({ href: a.getAttribute('href'), text: a.textContent })),
      headers: all('header').length, mains: all('main').length, footers: all('footer').length,
      primary: all('button.primary').map(b => ({ text: b.textContent, disabled: b.disabled })),
      buttons: all('button').map(b => b.className),
      styleAttrs: all('[style]').length,
      styleElements: all('style').length,
      inlineScripts: all('script:not([src])').length,
      scripts: all('script[src]').map(s => s.getAttribute('src')),
      footer: q('footer')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
      modelLine: q('[data-role="model"]')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      status: q('main p.status')?.textContent ?? null,
      storageSummary: q('[data-role="storage-summary"]')?.textContent ?? null,
      storageStates: all('[data-role="storage-state"]').map(s => s.textContent),
      drop: Boolean(q('main label.drop input[type="file"].visually-hidden')),
      resultHidden: q('main section.result')?.hidden ?? null,
    };
  });
}

export default [
  {
    name: 'loads clean in Spanish and English, with the markup contract and the credits',
    sites: 'all',
    async run(t, site) {
      const ctx = await t.newContext();
      for (const [path, lang] of [['/', 'es'], ['/en/', 'en']]) {
        const page = await t.open(ctx, site, path);
        const f = await pageFacts(page);
        const s = t.strings[site.site][lang];
        t.equal(f.lang, lang, `${path}: lang`);
        t.equal([f.headers, f.mains, f.footers], [1, 1, 1], `${path}: one header, main and footer`);
        t.ok(f.brand && f.brand.includes(s.title), `${path}: brand names the site`);
        t.ok(f.nav.length === 3 && f.nav[1].href === 'https://elffuss.com/', `${path}: nav has the catalog, elffuss.com and the other language`);
        t.equal([f.styleAttrs, f.styleElements, f.inlineScripts], [0, 0, 0], `${path}: no inline styles or scripts`);
        t.ok(f.scripts.length === 1, `${path}: one module script`);
        if (site.catalog) {
          t.equal(f.primary.length, 0, `${path}: the catalog has no buttons`);
          t.equal(f.buttons.length, 0, `${path}: the catalog has no buttons at all`);
          continue;
        }
        t.equal(f.primary.length, 1, `${path}: exactly one button.primary`);
        t.ok(f.buttons.every(c => c === 'primary' || c === 'ghost'), `${path}: every other button is .ghost`);
        t.ok(f.drop, `${path}: label.drop with its file input inside, visually hidden`);
        const m = t.registry.models[site.models[0]];
        for (const piece of [m.base.name, m.base.author, m.base.license]) t.ok(f.footer.includes(piece), `${path}: footer credits ${piece}`);
        t.ok(f.footer.includes('runonweb.ai'), `${path}: footer credits runonweb.ai`);
        t.ok(f.modelLine?.includes(s['privacy.download']), `${path}: the privacy line is on the page`);
        // The store answered: the storage panel says what is missing and the button includes the download.
        const choice = chooseVariant(m, 'auto', t.probe);
        const want = fill(s['action.downloadAndRun'], { size: `${formatMB(choice.variant.bytes, lang)} MB` });
        t.equal(f.primary[0].text, want, `${path}: primary button label on a fresh profile`);
        t.ok(f.storageSummary && f.storageSummary.length > 0, `${path}: storage summary filled`);
        t.ok(f.storageStates.length > 0 && f.storageStates.every(x => x === s['storage.missing']), `${path}: every file shown as not downloaded`);
        t.equal(f.resultHidden, true, `${path}: result hidden until there is one`);
        await t.noCsp(page);
      }
      for (const path of ['/licencias/', '/en/licenses/']) {
        const page = await t.open(ctx, site, path, { wait: 'load' });
        const f = await pageFacts(page);
        t.equal([f.styleAttrs, f.styleElements, f.inlineScripts, f.scripts.length], [0, 0, 0, 0], `${path}: static, no scripts`);
        if (!site.catalog) for (const p of Object.values(t.registry.models[site.models[0]].parts)) t.ok((await page.content()).includes(p.revision.slice(0, 12)), `${path}: names the pinned revision of ${p.repo}`);
      }
      t.noPageErrors();
      t.equal(t.hubTotal(), 0, 'nothing is downloaded before the primary button');
      t.networkClean(site);
    },
  },
  {
    name: 'without the model store: store-unavailable, and nothing from the Hub',
    sites: 'apps',
    async run(t, site) {
      const ctx = await t.newContext();
      await t.blockStore(ctx);
      const page = await t.open(ctx, site, '/', { timeout: 90000 });
      const f = await pageFacts(page);
      t.equal(f.status, t.strings[site.site].es['error.store-unavailable'], 'status line');
      t.equal(t.hubTotal(), 0, 'no Hub request');
      t.noPageErrors();
    },
  },
];
