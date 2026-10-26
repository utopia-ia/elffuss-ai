// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The Elffuss mark in the header of every site, in Chrome: first in the header and
// the first Tab stop, a link to https://elffuss.com/ with the label of the page's
// language, the brass leaf, "Elffuss" on the baseline of the site's name, 44 px to
// touch on a phone and nothing wider than the screen; on hover the leaf tilts, the
// spark and the line show; the focus ring stays clear of the dot; with reduced
// motion the leaf stays still. With SHOTS_DIR=<dir> it leaves
// mark-<site>-<width>-{rest,hover,focus}.png there.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HREF = 'https://elffuss.com/';
const SHOTS = process.env.SHOTS_DIR ? resolve(process.env.SHOTS_DIR) : null;
const pause = ms => new Promise(r => setTimeout(r, ms));

const facts = page => page.evaluate(RING => {
  const h = document.querySelector('header'), a = h.querySelector('a.elffuss-mark'), brand = h.querySelector('a.brand'), sep = h.querySelector('.brand-sep');
  const bottom = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects()[0]?.bottom ?? null; };
  const word = a.querySelector('.word');
  const ra = a.getBoundingClientRect();
  return {
    first: h.querySelector('a, button, [tabindex]') === a,
    href: a.getAttribute('href'), label: a.getAttribute('aria-label'),
    leaf: getComputedStyle(a.querySelector('.leaf')).fill,
    word: getComputedStyle(word).display === 'none' ? null : bottom(word), name: bottom(brand),
    nameLines: Math.round(brand.getBoundingClientRect().height / parseFloat(getComputedStyle(brand).lineHeight)),
    // What a finger can touch: the rows, through the middle of the leaf, that land on the mark.
    tap: (() => { const x = a.querySelector('svg').getBoundingClientRect(), cx = x.left + x.width / 2; let n = 0; for (let y = Math.floor(ra.top) - 12; y <= ra.bottom + 12; y++) if (document.elementFromPoint(cx, y)?.closest('a.elffuss-mark') === a) n++; return n; })(),
    // The ring of elffuss-mark.css (:focus-visible, 4 px offset + 2 px) lies 6 px outside the link: it must clear the
    // dot, stay inside the header and off the nav links when they wrap under the mark.
    ringToDot: sep.getBoundingClientRect().left - (ra.right + RING),
    ringInHeader: ra.top - RING >= h.getBoundingClientRect().top && ra.bottom + RING <= h.getBoundingClientRect().bottom,
    ringOffNav: [...h.querySelectorAll('nav a')].every(n => { const r = n.getBoundingClientRect(); return r.top >= ra.bottom + RING || r.bottom <= ra.top - RING || r.left >= ra.right + RING || r.right <= ra.left - RING; }),
    overflow: document.documentElement.scrollWidth > innerWidth,
  };
}, 6);

const effect = page => page.evaluate(() => {
  const a = document.querySelector('header a.elffuss-mark');
  return { leaf: getComputedStyle(a.querySelector('svg')).transform, spark: getComputedStyle(a.querySelector('.spark')).opacity, line: getComputedStyle(a.querySelector('.word'), '::after').transform };
});

export default [
  {
    name: 'the Elffuss mark opens the header: link, label, size, hover, focus and reduced motion',
    sites: 'all',
    configs: ['B'],
    async run(t, site) {
      if (SHOTS) mkdirSync(SHOTS, { recursive: true });
      const ctx = await t.newContext();
      const shot = (page, w, kind) => SHOTS && page.screenshot({ path: join(SHOTS, `mark-${site.site}-${w}-${kind}.png`), clip: { x: 0, y: 0, width: w, height: w < 600 ? 150 : 90 } });
      for (const w of [1280, 390, 375, 360, 320]) {
        for (const [path, lang] of [['/', 'es'], ['/en/', 'en']]) {
          const page = await t.open(ctx, site, path, { wait: 'shell-only' });
          await page.setViewportSize({ width: w, height: 800 });
          await page.mouse.move(w - 5, 700);
          await pause(300);
          const f = await facts(page);
          const at = `${path} at ${w}`;
          t.ok(f.first, `${at}: the mark is the first thing in the header`);
          t.equal([f.href, f.label], [HREF, t.strings[site.site][lang]['mark.aria']], `${at}: link and label`);
          t.equal(f.leaf, 'rgb(200, 160, 106)', `${at}: the brass leaf`);
          if (w >= 390) t.ok(f.word !== null && Math.abs(f.word - f.name) < 0.6, `${at}: "Elffuss" on the baseline of the name (${f.word} / ${f.name})`);
          else t.equal(f.word, null, `${at}: only the leaf under 390 px`);
          t.equal(f.nameLines, 1, `${at}: the site name in one line`);
          if (w < 600) t.ok(f.tap >= 44, `${at}: 44 px to touch (${f.tap})`);
          t.ok(f.ringToDot >= 6, `${at}: the focus ring stays clear of the dot (${f.ringToDot.toFixed(1)} px)`);
          t.ok(f.ringInHeader && f.ringOffNav, `${at}: the focus ring stays inside the header and off the nav`);
          t.ok(!f.overflow, `${at}: nothing wider than the screen`);
          if (lang !== 'es') continue;
          await shot(page, w, 'rest');
          const still = await effect(page);
          await page.hover('header a.elffuss-mark');
          await pause(450);
          const on = await effect(page);
          // Under 390 px the word, and so its line, is not shown.
          t.ok(still.leaf === 'none' && on.leaf !== 'none' && on.spark === '1' && (w < 390 || /^matrix\(1, 0, 0, 1,/.test(on.line)), `${at}: on hover the leaf tilts, the spark and the line show (${JSON.stringify(on)})`);
          await shot(page, w, 'hover');
          await page.mouse.move(w - 5, 700);
          await page.evaluate(() => { const i = document.createElement('span'); i.tabIndex = -1; i.id = 'start'; document.body.prepend(i); i.focus(); });
          await page.keyboard.press('Tab');
          await page.evaluate(() => document.getElementById('start')?.remove());
          await pause(450);
          t.ok(await page.evaluate(() => document.activeElement.matches('header a.elffuss-mark:focus-visible') && getComputedStyle(document.activeElement).outlineStyle !== 'none'), `${at}: the first Tab reaches the mark, with its ring`);
          await shot(page, w, 'focus');
        }
      }
      const page = await t.open(ctx, site, '/', { wait: 'shell-only' });
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.hover('header a.elffuss-mark');
      await pause(450);
      const r = await effect(page);
      t.ok(r.leaf === 'none' && /^matrix\(1, 0, 0, 1,/.test(r.line), `reduced motion: the leaf stays still, the line shows (${JSON.stringify(r)})`);
      t.noPageErrors();
      await t.noCsp(page);
    },
  },
];
