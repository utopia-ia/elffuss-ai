// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Positive controls: the harness must see what it claims to watch. A thrown
// error on the page, an inline script (refused by the CSP), and a request to
// another origin must each be caught; a harness that cannot see them would give
// false greens everywhere else.
export default [
  {
    name: 'the harness catches a page error, a CSP violation and a request elsewhere',
    sites: ['depth'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await page.evaluate(() => { setTimeout(() => { throw new Error('control: thrown on purpose'); }, 0); });
      await page.waitForTimeout(200);
      const caught = t.pageErrors.splice(0);
      t.ok(caught.some(e => /control: thrown on purpose/.test(e.message)), 'a page error is caught');
      // An inline script needs a Trusted Types sink, so the policy refuses it there first.
      await page.addScriptTag({ content: 'window.__inline = 1' }).catch(() => {});
      await page.waitForTimeout(200);
      t.equal(await page.evaluate(() => globalThis.__inline ?? null), null, 'the inline script did not run');
      t.ok((await t.csp(page)).some(x => x.directive === 'require-trusted-types-for'), 'and the refusal is recorded');
      // An image from another origin is refused by img-src.
      await page.evaluate(() => new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = 'https://example.org/x.png'; }));
      t.ok((await t.csp(page)).some(x => x.directive === 'img-src'), 'an image from another origin is refused and recorded');
      // A request to another origin is refused by connect-src.
      const fetched = await page.evaluate(() => fetch('https://example.org/').then(() => 'reached', () => 'blocked'));
      t.equal(fetched, 'blocked', 'connect-src blocks other origins');
      t.ok((await t.csp(page)).some(x => x.directive === 'connect-src'), 'and the violation is recorded');
      // A violation inside a Worker (here a module Worker of the page's own origin, like
      // the task's or PDF.js's) is recorded too.
      const base = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]')][0].href.replace(/shared\/tokens\.css$/, ''));
      const before = t.workers.length;
      await page.evaluate(async b => {
        const { scriptUrl } = await import(b + 'sdk/core/tt.js');
        globalThis.__w = new Worker(scriptUrl(b + '__test__/smoke-worker.js'), { type: 'module', name: 'control' });
      }, base).catch(() => {});
      await page.waitForTimeout(300);
      const w = t.workers[before];
      if (t.ok(w, 'the harness sees the Worker')) {
        await w.evaluate(() => fetch('https://example.org/from-a-worker').catch(() => {}));
        await page.waitForTimeout(200);
        t.ok((await t.csp(page)).some(x => x.where?.startsWith('worker') && x.directive === 'connect-src'), 'a violation inside a Worker is recorded');
        await w.evaluate(() => { self.__elffussCsp.length = 0; });
      }
      // Clean up what the controls left, so this test passes on its own merits.
      await page.evaluate(() => { globalThis.__elffuss.csp.length = 0; globalThis.__w?.terminate(); });
      t.requests = t.requests.filter(r => !r.url.startsWith('https://example.org'));
      t.noPageErrors();
    },
  },
];
