// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The ocr site through its real page, in both configurations: the Spanish
// invoice comes out exactly, with its lines, boxes and the overlay; a poor
// photo of it within 2 % of character errors; the «¡» sample as its golden
// reference, with the page saying the model lacks «¡»; a whole folder (nested
// folders, a two-page PDF, a two-page TIFF, broken, empty, hidden and
// unsupported files) with the exact statuses, paths, texts per file and page,
// and exports (ZIP listing, Markdown, JSON) equal to tests/fixtures/ocr/; files
// dropped on the zone; pause, resume and cancel; WebGPU asked for where there
// is none; the one retry on WebAssembly after a failure on WebGPU; TIFF pages
// compressed with JPEG decoded by the browser as libtiff decodes them; and a
// folder of 120 images read through in one go.
//
// ELFFUSS_AI_WRITE_GOLDEN=1 (configuration B) writes golden-exclamacion.txt
// from what the model reads; scripts/make-fixtures.mjs then lists it.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../../../sdk/core/zip.js';
import { normalizeText, characterErrorRate } from '../../../sdk/ocr/order.js';
import { chooseVariant } from '../../../sdk/core/device.js';
import { fill } from '../../../scripts/lib/template.mjs';
import { formatMB } from '../../../scripts/lib/pages.mjs';
import { projection } from '../../../scripts/make-fixtures.mjs';
import { expectedDevice } from '../harness.mjs';

const FIX = fileURLToPath(new URL('../../fixtures/ocr/', import.meta.url));
const expected = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'));
const READ_TIMEOUT = 15 * 60 * 1000;

/** Put files in the page's file input (or the folder input) and wait for the list. */
async function choose(page, files, { folder = false } = {}) {
  await page.setInputFiles(`input[data-input="${folder ? 'folder' : 'files'}"]`, files);
  await page.waitForFunction(() => !document.querySelector('[data-role="queue"]').hidden && document.querySelectorAll('ol[data-role="files"] > li').length > 0);
}

/** Press the primary button and wait until the reading ends (done, or stopped with an error shown). */
async function readAll(page) {
  await page.click('button.primary');
  await page.waitForFunction(() => {
    const d = globalThis.__elffuss;
    return d?.ocr && !d.ocr.reading && (d.ocr.done || d.errors.length > 0);
  }, null, { timeout: READ_TIMEOUT, polling: 250 });
  return page.evaluate(() => ({ errors: globalThis.__elffuss.errors.slice(), device: globalThis.__elffuss.device, fallback: globalThis.__elffuss.fallback, items: globalThis.__elffuss.ocr.items(), status: document.querySelector('main p.status').textContent }));
}

const docs = page => page.evaluate(() => globalThis.__elffuss.ocr.documents());

async function download(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`button[data-action="${action}"]`)]);
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

function checkLines(t, lines, width, height, label) {
  for (const l of lines) {
    const ok = l.polygon.length === 4 && l.box.xmin >= 0 && l.box.ymin >= 0 && l.box.xmax <= width && l.box.ymax <= height && l.box.xmin < l.box.xmax && l.box.ymin < l.box.ymax && l.score >= 0.5 && l.score <= 1;
    if (!t.ok(ok, `${label}: line "${l.text}" has a sane box and score (${JSON.stringify(l.box)}, ${l.score})`)) return;
  }
}

function checkDevice(t, r, site) {
  t.equal(r.device, expectedDevice(site, t.registry, t.config), 'backend used');
  t.equal(r.fallback, null, 'no fallback');
}

export default [
  {
    name: 'reads the Spanish invoice exactly, with its lines, their boxes and the overlay',
    sites: ['ocr'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const s = t.strings.ocr.es;
      const m = t.registry.models[site.models[0]];
      const before = await page.textContent('button.primary');
      t.equal(before, fill(s['action.downloadAndRun'], { size: `${formatMB(chooseVariant(m, 'auto', t.probe).variant.bytes, 'es')} MB` }), 'primary label before: download and read');
      t.equal(await page.textContent('[data-role="model-note"]'), m.notes.es, 'the model note is on the page');
      await choose(page, join(FIX, 'factura.png'));
      const r = await readAll(page);
      if (!t.ok(!r.errors.length, `no error: ${JSON.stringify(r.errors)} ${r.status}`)) return;
      checkDevice(t, r, site);
      const doc = JSON.parse((await docs(page)).json);
      const f = doc.files[0];
      t.equal(f.status, 'ok', 'status');
      t.equal(normalizeText(f.pages[0].text), normalizeText(expected['factura.png'].text), 'the text, exactly');
      t.equal(f.pages[0].lines.map(l => l.text), expected['factura.png'].lines, 'the lines, in reading order');
      t.equal([f.pages[0].width, f.pages[0].height], [expected['factura.png'].width, expected['factura.png'].height], 'page size');
      checkLines(t, f.pages[0].lines, f.pages[0].width, f.pages[0].height, 'factura');
      const shown = await page.evaluate(() => [...document.querySelectorAll('figure.stage:not([hidden]) canvas')].map(c => [c.width, c.height]));
      // ELFFUSS_AI_SCREENSHOTS=1 keeps a picture of the page in $ELFFUSS_AI_CACHE/logs (never in the repo).
      if (process.env.ELFFUSS_AI_SCREENSHOTS === '1') await page.screenshot({ path: join(t.cache, 'logs', `ocr-invoice-${t.browser}-${t.config}.png`), fullPage: true });
      t.ok(shown.length === 2 && shown.every(([w, h]) => w > 0 && h > 0), `the page and its boxes are drawn (${JSON.stringify(shown)})`);
      const pre = await page.textContent('article.card pre[data-role="text"]');
      t.equal(normalizeText(pre), normalizeText(expected['factura.png'].text), 'the card shows the text');
      const meta = await page.textContent('article.card [data-role="meta"]');
      t.ok(meta.includes(s['device.' + r.device]), `the card says the backend (${meta})`);
      t.equal(await page.textContent('button.primary'), s['action.run'], 'primary label after: the model is in this browser');
      const txt = await download(page, 'download-txt');
      t.equal(txt.name, 'factura.png.txt', 'txt name');
      t.equal(txt.bytes.toString('utf8'), `${expected['factura.png'].text}\n`, 'txt content');
      await t.noCsp(page);
      t.noPageErrors();
      t.networkClean(site);
      const side = await page.evaluate(() => globalThis.__elffuss.ocr.readSide);
      t.ok(side === 4000 || side === 2560, `pages are read up to ${side} pixels`);
      t.note(`${r.device}; ${f.pages[0].lines.length} lines; pages up to ${side} px`);
    },
  },
  {
    name: 'reads a poor photo of the invoice with at most 2 % character errors',
    sites: ['ocr'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await choose(page, join(FIX, 'foto-factura.jpg'));
      const r = await readAll(page);
      if (!t.ok(!r.errors.length, `no error: ${JSON.stringify(r.errors)}`)) return;
      checkDevice(t, r, site);
      const text = JSON.parse((await docs(page)).json).files[0].pages[0].text;
      const cer = characterErrorRate(text, expected['foto-factura.jpg'].text);
      t.ok(cer <= expected['foto-factura.jpg'].maxCharacterErrorRate, `character error rate ${(100 * cer).toFixed(2)} % (at most 2 %): ${JSON.stringify(text)}`);
      t.note(`CER ${(100 * cer).toFixed(2)} %`);
      t.noPageErrors();
    },
  },
  {
    name: 'the «¡» sample reads as its reference, and the page says the model has no «¡»',
    sites: ['ocr'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await choose(page, join(FIX, 'exclamacion.png'));
      const r = await readAll(page);
      if (!t.ok(!r.errors.length, `no error: ${JSON.stringify(r.errors)}`)) return;
      const text = JSON.parse((await docs(page)).json).files[0].pages[0].text;
      if (process.env.ELFFUSS_AI_WRITE_GOLDEN === '1' && t.config === 'B') writeFileSync(join(FIX, 'golden-exclamacion.txt'), `${text}\n`);
      const golden = readFileSync(join(FIX, 'golden-exclamacion.txt'), 'utf8').replace(/\n$/, '');
      t.equal(text, golden, 'the golden reference');
      t.ok(!text.includes('¡'), 'no «¡» in the output');
      const note = await page.textContent('[data-role="model-note"]');
      t.ok(note.includes('«¡»') && !(await page.isHidden('[data-role="model-note"]')), `the page says it: ${note}`);
      t.noPageErrors();
    },
  },
  {
    name: 'reads a whole folder: statuses, paths, texts per file and page, and the three exports',
    sites: ['ocr'],
    async run(t, site) {
      const ctx = await t.newContext();
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(t.url(site)).origin });
      const page = await t.open(ctx, site, '/');
      const s = t.strings.ocr.es;
      await choose(page, join(FIX, 'carpeta'), { folder: true });
      const summary = await page.textContent('[data-role="queue-summary"]');
      t.equal(summary, '10 archivos: 5 imágenes y 1 PDF; 4 se omiten.', 'the summary of the list');
      const r = await readAll(page);
      if (!t.ok(!r.errors.length, `no error: ${JSON.stringify(r.errors)} ${r.status}`)) return;
      const want = JSON.parse(readFileSync(join(FIX, 'carpeta.expected.json'), 'utf8'));
      const got = projection(JSON.parse((await docs(page)).json));
      t.equal(got.files.map(f => [f.path, f.status, f.reason ?? f.error ?? '']), want.files.map(f => [f.path, f.status, f.reason ?? f.error ?? '']), 'paths and statuses');
      for (const wf of want.files.filter(f => f.pages)) {
        const gf = got.files.find(f => f.path === wf.path);
        for (const wp of wf.pages) {
          const gp = gf?.pages?.find(p => p.page === wp.page);
          t.equal(gp?.text, wp.text, `${wf.path} page ${wp.page}: text`);
          t.equal(gp?.lines, wp.lines, `${wf.path} page ${wp.page}: lines`);
          t.equal([gp?.width, gp?.height], [wp.width, wp.height], `${wf.path} page ${wp.page}: size`);
        }
      }
      t.equal(got, want, 'the JSON document (without build, device, scores and boxes)');
      const full = JSON.parse((await docs(page)).json);
      for (const f of full.files.filter(x => x.pages)) for (const p of f.pages) checkLines(t, p.lines, p.width, p.height, `${f.path} page ${p.page}`);
      const md = readFileSync(join(FIX, 'carpeta.expected.md'), 'utf8');
      const listing = readFileSync(join(FIX, 'carpeta.expected.zip.txt'), 'utf8').trim().split('\n');
      const zip = await download(page, 'download-zip');
      t.ok(/^ocr-carpeta-\d{8}-\d{4}\.zip$/.test(zip.name), `ZIP name ${zip.name}`);
      const entries = readZip(new Uint8Array(zip.bytes));
      t.equal(entries.map(e => e.name), listing, 'ZIP listing');
      const entry = n => Buffer.from(entries.find(e => e.name === n)?.data || []).toString('utf8');
      t.equal(entry('texto.md'), md, 'ZIP: the Markdown');
      t.equal(projection(JSON.parse(entry('texto.json'))), want, 'ZIP: the JSON');
      t.equal(entry('texto/notas/acta.pdf.txt'), want.files.find(f => f.path === 'notas/acta.pdf').pages.map(p => p.text + '\n').join('\f'), 'ZIP: the PDF text, pages separated by a form feed');
      const mdFile = await download(page, 'download-md');
      t.equal([mdFile.name, mdFile.bytes.toString('utf8')], ['texto.md', md], 'Markdown download');
      const jsonFile = await download(page, 'download-json');
      t.equal(jsonFile.name, 'texto.json', 'JSON download name');
      t.equal(projection(JSON.parse(jsonFile.bytes.toString('utf8'))), want, 'JSON download');
      await page.bringToFront();
      await page.click('button[data-action="copy-all"]');
      const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
      if (copied === null) t.note('clipboard not readable here: copy not checked');
      else t.equal(copied, md, 'copy everything gives the Markdown');
      const cards = await page.evaluate(() => [...document.querySelectorAll('article.card')].map(c => [c.dataset.path, c.dataset.status]));
      t.equal(cards, got.files.filter(f => f.reason !== 'hidden').map(f => [f.path, f.status]), 'one card per file that is not hidden, with its status');
      t.ok(r.status.startsWith(s['read.done'].split('{')[0]), `final status: ${r.status}`);
      await t.noCsp(page);
      t.noPageErrors();
      t.networkClean(site);
      t.note(`${r.device}`);
    },
  },
  {
    name: 'files dropped on the zone are listed and read',
    sites: ['ocr'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const files = ['exclamacion.png', 'factura.png'].map(n => ({ name: n, b64: readFileSync(join(FIX, n)).toString('base64') }));
      await page.evaluate(list => {
        const dt = new DataTransfer();
        for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), c => c.charCodeAt(0))], f.name, { type: 'image/png' }));
        document.querySelector('label.drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, files);
      await page.waitForFunction(() => document.querySelectorAll('ol[data-role="files"] > li').length === 2);
      const r = await readAll(page);
      if (!t.ok(!r.errors.length, `no error: ${JSON.stringify(r.errors)}`)) return;
      t.equal(r.items.map(i => [i.path, i.status]), [['exclamacion.png', 'ok'], ['factura.png', 'ok']], 'both read, in order');
      t.equal(normalizeText(r.items[1].pages[0].text), normalizeText(expected['factura.png'].text), 'the invoice text');
      t.noPageErrors();
    },
  },
  {
    name: 'pause waits, resume goes on, cancel keeps what was read and the rest reads later',
    sites: ['ocr'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await choose(page, join(FIX, 'carpeta'), { folder: true });
      await page.click('button.primary');
      await page.click('button[data-action="pause"]');
      await page.waitForFunction(() => globalThis.__elffuss.ocr.waiting, null, { timeout: READ_TIMEOUT });
      const snapshot = JSON.stringify(await page.evaluate(() => globalThis.__elffuss.ocr.items()));
      await page.waitForTimeout(2000);
      let items = await page.evaluate(() => globalThis.__elffuss.ocr.items());
      t.equal(JSON.stringify(items), snapshot, 'nothing is read while paused');
      t.equal(await page.textContent('main p.status'), t.strings.ocr.es['read.paused'], 'the page says it is paused');
      await page.click('button[data-action="resume"]');
      await page.waitForFunction(() => globalThis.__elffuss.ocr.items().filter(i => i.status === 'ok').length >= 1, null, { timeout: READ_TIMEOUT });
      await page.click('button[data-action="cancel"]');
      await page.waitForFunction(() => !globalThis.__elffuss.ocr.reading, null, { timeout: READ_TIMEOUT });
      items = await page.evaluate(() => globalThis.__elffuss.ocr.items());
      const doc = JSON.parse((await docs(page)).json);
      t.ok(doc.summary.ok >= 1 && doc.summary.notProcessed >= 1, `cancel keeps what was read (${JSON.stringify(doc.summary)})`);
      t.equal(await page.textContent('main p.status'), t.strings.ocr.es['error.aborted'], 'the page says it was cancelled');
      t.equal(await page.isEnabled('button.primary'), true, 'the rest can be read');
      const r = await readAll(page);
      t.ok(!r.errors.filter(e => e !== 'aborted').length, `no error after: ${JSON.stringify(r.errors)}`);
      const want = JSON.parse(readFileSync(join(FIX, 'carpeta.expected.json'), 'utf8'));
      t.equal(projection(JSON.parse((await docs(page)).json)), want, 'and then the whole folder is as expected');
      t.noPageErrors();
    },
  },
  {
    name: 'TIFF pages compressed with JPEG decode in the browser as libtiff decodes them',
    sites: ['ocr'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const b64 = n => readFileSync(join(FIX, 'tiff', n)).toString('base64');
      const result = await page.evaluate(async files => {
        const base = new URL(document.querySelector('script[type="module"]').src).pathname.replace(/app\.js$/, '');
        const tiff = await import(base + 'tiff.js');
        const docs = await import(base + 'documents.js');
        const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
        const out = {};
        for (const [name, [jpeg, ref]] of Object.entries(files)) {
          const a = bytes(jpeg), r = bytes(ref);
          const img = await tiff.decodeTiffPage(a, tiff.tiffPages(a).pages[0], { decodeJpeg: docs.decodeJpeg });
          const want = await tiff.decodeTiffPage(r, tiff.tiffPages(r).pages[0]);
          let sum = 0, max = 0, n = 0;
          for (let i = 0; i < img.data.length; i++) { if (i % 4 === 3) continue; const d = Math.abs(img.data[i] - want.data[i]); sum += d; n++; if (d > max) max = d; }
          out[name] = { size: [img.width, img.height], want: [want.width, want.height], mean: sum / n, max };
        }
        return out;
      }, { colour: [b64('co-jpeg.tif'), b64('co-jpeg-rgba.tif')], grey: [b64('gr-jpeg.tif'), b64('gr-jpeg-rgba.tif')] });
      for (const [name, r] of Object.entries(result)) {
        t.equal(r.size, r.want, `${name}: size`);
        t.ok(r.mean <= 2 && r.max <= 48, `${name}: within JPEG decoder differences of libtiff's (mean ${r.mean.toFixed(2)}, largest ${r.max})`);
        t.note(`${name} mean ${r.mean.toFixed(2)} max ${r.max}`);
      }
      await t.noCsp(page);
      t.noPageErrors();
    },
  },
  {
    name: 'a folder of 120 images in nested folders is read through, one file after another',
    sites: ['ocr'],
    configs: ['B'],
    async run(t, site) {
      const dir = mkdtempSync(join(t.cache, 'tmp', 'many-'));
      try {
        const png = readFileSync(join(FIX, 'exclamacion.png'));
        for (let i = 0; i < 120; i++) {
          const d = join(dir, 'lote', `parte-${i % 4}`, `grupo-${i % 3}`);
          mkdirSync(d, { recursive: true });
          writeFileSync(join(d, `imagen-${i}.png`), png);
        }
        const ctx = await t.newContext();
        const page = await t.open(ctx, site, '/');
        await choose(page, join(dir, 'lote'), { folder: true });
        const r = await readAll(page);
        if (!t.ok(!r.errors.length, `no error: ${JSON.stringify(r.errors)}`)) return;
        const golden = readFileSync(join(FIX, 'golden-exclamacion.txt'), 'utf8').replace(/\n$/, '');
        // Some file systems add hidden companion files (._name): they must be left out without a word.
        const hidden = r.items.filter(i => i.reason === 'hidden');
        t.ok(hidden.every(i => i.status === 'skipped' && i.path.split('/').some(p => p.startsWith('.'))), 'only hidden files are left out');
        const visible = r.items.filter(i => i.reason !== 'hidden');
        t.equal(visible.length, 120, 'every file listed');
        t.equal(visible.filter(i => i.status === 'ok' && i.pages[0].text === golden).length, 120, 'every file read, each with its text');
        if (hidden.length) t.note(`${hidden.length} hidden companion files left out`);
        const order = visible.map(i => i.path);
        t.equal(order[0], 'parte-0/grupo-0/imagen-0.png', 'natural order: 0 first');
        t.ok(order.indexOf('parte-0/grupo-0/imagen-12.png') > order.indexOf('parte-0/grupo-0/imagen-0.png') && order.indexOf('parte-0/grupo-0/imagen-12.png') < order.indexOf('parte-0/grupo-0/imagen-24.png'), 'natural order of numbers');
        const doc = JSON.parse((await docs(page)).json);
        t.equal(doc.summary, { files: 120 + hidden.length, ok: 120, skipped: hidden.length, errors: 0, notProcessed: 0, pages: 120 }, 'summary');
        t.ok((await docs(page)).json.length < 2e6, 'only text and boxes are kept');
        t.noPageErrors();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'WebGPU asked for where there is none: the page says so',
    sites: ['ocr'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/?device=webgpu');
      t.equal(await page.textContent('main p.status'), t.strings.ocr.es['error.webgpu-unavailable'], 'status');
      t.noPageErrors();
    },
  },
  {
    name: 'after a failure inside the runtime the page still reads the file (WebGPU: once more on WASM, and says so)',
    sites: ['ocr'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/?test-fail=run');
      await choose(page, join(FIX, 'factura.png'));
      const r = await readAll(page);
      if (!t.ok(!r.errors.length, `no error: ${JSON.stringify(r.errors)} ${r.status}`)) return;
      const text = JSON.parse((await docs(page)).json).files[0].pages[0].text;
      t.equal(normalizeText(text), normalizeText(expected['factura.png'].text), 'the text, exactly');
      if (t.config === 'A') {
        t.equal(r.fallback, { from: 'webgpu', reason: 'run-failed' }, 'the retry on WASM');
        t.equal(r.device, 'wasm', 'read on WASM');
        t.ok(r.status.includes(t.strings.ocr.es['fallback.wasm']), `the page says so: ${r.status}`);
      } else {
        t.equal(r.device, 'wasm', 'WASM');
        t.equal(r.fallback, null, 'no change of backend with WASM');
      }
      t.noPageErrors();
    },
  },
];
