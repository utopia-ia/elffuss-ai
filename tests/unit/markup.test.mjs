// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The built pages, styles and scripts keep the contract the shared stylesheet
// relies on: no inline styles or scripts, one primary button per app and none in
// the catalog, the stylesheet order, layout-only CSS whose only colours are the
// eight variables, no colours or DOM injection in JavaScript, and production
// builds that point at the real store with the test hooks off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildSite, FORBIDDEN_IN_BUILD } from '../../scripts/build.mjs';
import { sites as readSites } from '../../deploy/sites.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TOKENS = ['--bg', '--bg2', '--bg3', '--line', '--fg', '--muted', '--accent', '--accent2'];

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (!e.name.startsWith('._')) out.push(p);
  }
  return out;
}

function build(channel) {
  const out = mkdtempSync(join(tmpdir(), `elffuss-ai-markup-${channel}-`));
  const sites = readSites(ROOT);
  for (const s of sites) buildSite({ root: ROOT, site: s, sites, channel, buildId: 'test00000000', outDir: out });
  return { out, sites };
}

const pro = build('pro');
const testBuild = build('test');
test.after(() => { rmSync(pro.out, { recursive: true, force: true }); rmSync(testBuild.out, { recursive: true, force: true }); });

const htmlFiles = dir => walk(dir).filter(p => p.endsWith('.html'));

test('no inline styles, no style elements, no inline scripts, at most one module script', () => {
  for (const f of htmlFiles(pro.out)) {
    const html = readFileSync(f, 'utf8');
    const rel = relative(pro.out, f);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${rel}: style attribute`);
    assert.doesNotMatch(html, /<style[\s>]/i, `${rel}: <style>`);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const [, attrs, body] of scripts) {
      assert.match(attrs, /\bsrc="/, `${rel}: inline script`);
      assert.match(attrs, /\btype="module"/, `${rel}: classic script`);
      assert.equal(body.trim(), '', `${rel}: script with a body`);
    }
    assert.ok(scripts.length <= 1, `${rel}: ${scripts.length} scripts`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${rel}: inline event handler`);
  }
});

test('one button.primary per app page, every other button .ghost, none in the catalog', () => {
  for (const s of pro.sites) {
    for (const page of ['index.html', 'en/index.html']) {
      const html = readFileSync(join(pro.out, s.site, page), 'utf8');
      const buttons = [...html.matchAll(/<button\b[^>]*class="([^"]*)"/g)].map(m => m[1]);
      const all = (html.match(/<button\b/g) || []).length;
      assert.equal(buttons.length, all, `${s.site}/${page}: a button without a class`);
      if (s.catalog) { assert.equal(all, 0, `${s.site}/${page}: the catalog has only links`); continue; }
      assert.equal(buttons.filter(c => c.split(/\s+/).includes('primary')).length, 1, `${s.site}/${page}: one button.primary`);
      for (const c of buttons) assert.ok(['primary', 'ghost'].includes(c), `${s.site}/${page}: button class "${c}"`);
      assert.match(html, /<header>[\s\S]*class="brand"[\s\S]*<nav>[\s\S]*<\/header>[\s\S]*<main>[\s\S]*<\/main>[\s\S]*<footer>/, `${s.site}/${page}: header, main, footer`);
      assert.match(html, /<label class="drop">[\s\S]*?<input class="visually-hidden" type="file"/, `${s.site}/${page}: drop zone`);
      assert.match(html, /<section class="result" hidden>/, `${s.site}/${page}: result section hidden`);
    }
  }
});

test('stylesheets in order: tokens, layout, the site, the shared look, the Elffuss mark', () => {
  for (const f of htmlFiles(pro.out)) {
    const html = readFileSync(f, 'utf8');
    const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1].replace(/^\/v\/[^/]+\//, ''));
    const site = relative(pro.out, f).split(sep)[0];
    assert.deepEqual(hrefs, ['shared/tokens.css', 'shared/layout.css', site === 'tools' ? 'catalog.css' : 'app.css', 'shared/elffuss-look.css', 'shared/elffuss-mark.css'], relative(pro.out, f));
  }
});

// The mark as approved (f3d3d69): the sheet byte for byte, and on every page the markup of its header comment with the
// label in the page's language, first in the header, followed by the site's name as its own link.
const MARK_SHEET_SHA1 = '627569b7695e8a26bee673e2433adf6086b33413';
test('every page opens its header with the Elffuss mark, then the site name; the mark sheet is the approved one', async () => {
  const { createHash } = await import('node:crypto');
  const sheet = readFileSync(join(ROOT, 'shared', 'elffuss-mark.css'));
  assert.equal(createHash('sha1').update(sheet).digest('hex'), MARK_SHEET_SHA1, 'shared/elffuss-mark.css is not the approved sheet');
  const doc = /(<a class="elffuss-mark"[\s\S]*?<\/a>)/.exec(sheet.toString('utf8'))[1];
  const labels = { es: 'Elffuss: todas las apps', en: 'Elffuss: all apps' };
  for (const f of htmlFiles(pro.out)) {
    const html = readFileSync(f, 'utf8');
    const rel = relative(pro.out, f);
    const lang = /<html lang="(es|en)">/.exec(html)?.[1];
    const m = /<header>\s*<div class="brand-row">\s*(<a class="elffuss-mark"[\s\S]*?<\/a>)\s*<span class="brand-sep" aria-hidden="true">·<\/span>\s*<a class="brand" href="[^"]+">([^<]+)<\/a>\s*<\/div>\s*<nav>/.exec(html);
    assert.ok(m, `${rel}: header starts with the mark, the dot and the site name`);
    assert.equal(m[1], doc.replace('aria-label="Elffuss: all apps"', `aria-label="${labels[lang]}"`), `${rel}: the mark's markup and its ${lang} label`);
    assert.doesNotMatch(m[2], /Elffuss/, `${rel}: the name no longer repeats "Elffuss"`);
  }
});

// Properties a layout sheet may use. Colours only as background/color with a variable.
const LAYOUT = /^(display|flex(-[a-z]+)?|grid(-[a-z]+)*|gap|row-gap|column-gap|order|align-[a-z]+|justify-[a-z]+|place-[a-z]+|margin(-[a-z]+)?|padding(-[a-z]+)?|width|height|min-width|min-height|max-width|max-height|aspect-ratio|position|inset|top|right|bottom|left|overflow(-[xy])?|object-fit|object-position|box-sizing)$/;

function declarations(css) {
  const out = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    for (const d of m[2].split(';').map(x => x.trim()).filter(Boolean)) {
      const i = d.indexOf(':');
      out.push({ selector, prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() });
    }
  }
  return out;
}

test('layout sheets only lay out; their only colours are the eight variables', () => {
  const sheets = [join(ROOT, 'shared', 'layout.css'), join(ROOT, 'catalog', 'catalog.css'), ...readSites(ROOT).filter(s => !s.catalog).map(s => join(ROOT, s.dir, 'app.css'))];
  for (const f of sheets) {
    const rel = relative(ROOT, f);
    const css = readFileSync(f, 'utf8');
    for (const { selector, prop, value } of declarations(css)) {
      assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|\b(white|black|red|blue|green|gray|grey|transparent|currentcolor)\b/i, `${rel}: ${selector} { ${prop}: ${value} } writes a colour`);
      if (prop === 'color' || prop === 'background') {
        assert.match(value, new RegExp(`^var\\((${TOKENS.join('|')})\\)$`), `${rel}: ${selector} { ${prop}: ${value} }`);
        continue;
      }
      if (selector === '.visually-hidden' && ['clip-path', 'white-space'].includes(prop)) continue;
      assert.match(prop, LAYOUT, `${rel}: ${selector} { ${prop} } is not layout`);
    }
  }
});

test('tokens.css defines the eight variables and nothing else; elffuss-look.css loads nothing', () => {
  const decl = declarations(readFileSync(join(ROOT, 'shared', 'tokens.css'), 'utf8'));
  assert.deepEqual(decl.map(d => d.prop).sort(), [...TOKENS].sort());
  for (const d of decl) assert.match(d.value, /^#[0-9a-f]{6}$/);
  // The look sheet is the UI session's: it may set colours and type, but it cannot
  // load fonts, images or other sheets (the CSP would refuse them: font-src 'none').
  const look = readFileSync(join(ROOT, 'shared', 'elffuss-look.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(look, /@import|@font-face|url\s*\(/i);
});

test('scripts write no colours, no inline styles and no HTML', () => {
  const files = ['sdk', 'shared', 'apps', 'catalog'].flatMap(d => walk(join(ROOT, d))).filter(f => /\.m?js$/.test(f));
  for (const f of files) {
    const rel = relative(ROOT, f);
    const js = readFileSync(f, 'utf8');
    assert.doesNotMatch(js, /['"`]#[0-9a-f]{3,8}['"`]|rgba?\(\s*\d|hsla?\(\s*\d/i, `${rel}: a colour literal`);
    assert.doesNotMatch(js, /\.style\.|setAttribute\(\s*['"]style['"]|cssText/, `${rel}: inline style`);
    assert.doesNotMatch(js, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/, `${rel}: HTML injection`);
    assert.doesNotMatch(js, /\beval\(|new Function\(/, `${rel}: eval`);
  }
});

test('nothing that could empty, fill or list the store reaches a build', () => {
  for (const f of walk(pro.out).filter(p => /\.(html|js|json)$/.test(p) && !p.includes(`${sep}vendor${sep}`))) {
    const text = readFileSync(f, 'utf8');
    for (const bad of FORBIDDEN_IN_BUILD) assert.equal(text.includes(bad), false, `${relative(pro.out, f)}: ${bad}`);
  }
});

test('production points at the real store with the hooks off; the test build does not', () => {
  for (const s of pro.sites) {
    const cfg = readFileSync(join(pro.out, s.site, 'v', 'test00000000', 'config.js'), 'utf8');
    assert.match(cfg, /"storeUrl": "https:\/\/models\.elffuss\.com\/"/, s.site);
    assert.match(cfg, /"testHooks": false/, s.site);
    assert.equal(existsSync(join(pro.out, s.site, '__test__')), false, `${s.site}: no test page in production`);
    assert.equal(existsSync(join(pro.out, s.site, 'v', 'test00000000', '__test__')), false, `${s.site}: no test module in production`);
    for (const f of htmlFiles(join(pro.out, s.site))) assert.doesNotMatch(readFileSync(f, 'utf8'), /http-equiv="Content-Security-Policy"/, 'production carries the CSP in headers');
    const tcfg = readFileSync(join(testBuild.out, s.site, 'v', 'test00000000', 'config.js'), 'utf8');
    assert.match(tcfg, /"storeUrl": "http:\/\/localhost:8789\/"/, s.site);
    assert.match(readFileSync(join(testBuild.out, s.site, 'index.html'), 'utf8'), /http-equiv="Content-Security-Policy"/, `${s.site}: test pages carry the CSP in a meta too`);
  }
});

test('each site ships only its runtimes', () => {
  const has = (s, p) => existsSync(join(pro.out, s, ...p.split('/')));
  assert.ok(has('ocr', 'vendor/pdfjs-dist@6.4.299/build/pdf.min.mjs'));
  for (const s of ['cutout', 'depth', 'detect', 'tools']) assert.equal(has(s, 'vendor/pdfjs-dist@6.4.299'), false, `${s}: PDF.js`);
  assert.equal(has('tools', 'vendor'), false, 'the catalog ships no runtime');
  for (const s of ['cutout', 'detect']) {
    assert.ok(has(s, 'vendor/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.wasm'), `${s}: the WebAssembly-only variant`);
    assert.equal(has(s, 'vendor/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.asyncify.wasm'), false, `${s}: not the WebGPU variant`);
  }
  for (const s of ['depth', 'ocr']) assert.ok(has(s, 'vendor/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.asyncify.wasm'), `${s}: the WebGPU variant`);
  assert.equal(has('ocr', 'vendor/@huggingface'), false, 'the OCR uses ONNX Runtime directly');
});

test('licences: what Transformers.js bundles, the modified-file line, and the source of the MPL parts', () => {
  const read = (s, p) => readFileSync(join(pro.out, s, ...p.split('/')), 'utf8');
  for (const s of ['cutout', 'depth', 'detect']) {
    const dir = readdirSync(join(pro.out, s, 'vendor', '@huggingface'))[0];
    const tf = read(s, `vendor/@huggingface/${dir}/transformers.web.min.js`);
    assert.match(tf.split('\n')[0], /^\/\*! Modified by UtopiaIA/, `${s}: the served Transformers.js says it was modified`);
    for (const lib of ['jinja@0.5.10', 'tokenizers@0.2.0']) {
      assert.ok(existsSync(join(pro.out, s, 'vendor', '@huggingface', dir, 'bundled', '@huggingface', lib, 'LICENSE')), `${s}: ${lib} licence served`);
    }
    for (const [page, lang] of [['licencias/index.html', 'es'], ['en/licenses/index.html', 'en']]) {
      const html = read(s, page);
      assert.match(html, /bundled\/@huggingface\/jinja@0\.5\.10\/LICENSE/, `${s} ${lang}: links the jinja licence`);
      assert.match(html, /bundled\/@huggingface\/tokenizers@0\.2\.0\/LICENSE/, `${s} ${lang}: links the tokenizers licence`);
    }
  }
  for (const s of ['cutout', 'depth', 'detect', 'ocr']) {
    for (const page of ['licencias/index.html', 'en/licenses/index.html']) {
      const html = read(s, page);
      assert.ok(html.includes('https://github.com/microsoft/onnxruntime/tree/v1.30.0'), `${s} ${page}: ONNX Runtime source`);
      assert.ok(html.includes('https://github.com/eigen-mirror/eigen/archive/1d8b82b0740839c0de7f1242a3585e3390ff5f33.zip'), `${s} ${page}: Eigen source (MPL-2.0)`);
      assert.match(html, /MPL-2\.0/, `${s} ${page}: names the MPL`);
    }
  }
  const notice = readFileSync(join(ROOT, 'NOTICE'), 'utf8');
  for (const piece of ['@huggingface/jinja 0.5.10', 'MIT License', '@huggingface/tokenizers 0.2.0', 'Mozilla Public License 2.0', 'modified']) assert.ok(notice.includes(piece), `NOTICE: ${piece}`);
});
