#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Builds the static sites.
//
//   node scripts/build.mjs <site>|all [--channel pro|pre|test] [--out <dir>] [--dev]
//
// pro and pre build from `git archive HEAD` in a temporary directory and refuse a
// dirty tree; --dev builds the working tree (for local work and the test
// harness; the deploy scripts refuse it). The build id is the 12-character HEAD
// commit (`dev` with --dev).
//
// Output per site, dist/<site>/:
//   index.html, en/index.html, licencias/index.html, en/licenses/index.html, 404.html, robots.txt
//     (pre: the same under beta/, without robots.txt)
//   v/<id>/   app.js (or catalog.js), the site's other modules, app.css, config.js,
//             strings.es.json, strings.en.json, shared/, sdk/core/, sdk/<task>/,
//             registry/tasks.json, LICENSES/, NOTICE.txt
//   vendor/   only the runtimes this site uses, with their licences; Transformers.js
//             rewritten to import the site's ONNX Runtime variant
// The runtimes are not in git: they come from the working tree's vendor/, which
// must match vendor/manifest.json byte for byte (fetched first when missing,
// see scripts/vendor.mjs --ensure).
// test channel only: the policy in a <meta>, the store at http://localhost:8789/,
//   test hooks on, and the core smoke page at __test__/core.html.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sites as readSites } from '../deploy/sites.mjs';
import { STORE_ORIGIN, csp } from '../deploy/headers.mjs';
import { sitePages, configSource, siteOrtVariant, siteModels } from './lib/pages.mjs';
import { rewriteTransformers } from './lib/rewrite-transformers.mjs';
import { ORT_VARIANTS, transformersDir, ortSpecifierFromTransformers } from '../sdk/core/runtimes.js';
import { VENDOR_DIRS } from '../sdk/core/runtime-pins.js';
import { ensure as ensureVendor } from './vendor.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GIT = '/usr/bin/git';
export const TEST_STORE_URL = 'http://localhost:8789/';
/** Strings that must never reach a built site: the tools never empty, fill or list the store. */
export const FORBIDDEN_IN_BUILD = ['elffuss-model-clear', 'elffuss-model-put', 'elffuss-broker-diag'];

function listFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (!e.name.startsWith('._') && e.name !== '.DS_Store') out.push(relative(base, p).split(sep).join('/'));
  }
  return out.sort();
}

function put(dst, content) {
  mkdirSync(dirname(dst), { recursive: true });
  if (Buffer.isBuffer(content) || typeof content === 'string') writeFileSync(dst, content);
  else copyFileSync(content.from, dst);
}

const readJSON = p => JSON.parse(readFileSync(p, 'utf8'));

/** Merge the shared strings with a site's, refusing a key that one language lacks. */
export function mergeStrings(root, dir) {
  const out = {};
  for (const lang of ['es', 'en']) out[lang] = { ...readJSON(join(root, 'shared', `strings.${lang}.json`)), ...readJSON(join(root, dir, `strings.${lang}.json`)) };
  const a = Object.keys(out.es).sort().join('\n'), b = Object.keys(out.en).sort().join('\n');
  if (a !== b) throw new Error(`${dir}: es and en strings do not have the same keys`);
  return out;
}

/**
 * Build one site into `outDir/<site>/`. Returns the list of written paths.
 * `vendorDir` is where the runtimes are read from (default `<root>/vendor`).
 * @param {{ root: string, site: object, sites: object[], channel: 'pro'|'pre'|'test', buildId: string, outDir: string, vendorDir?: string }} o
 */
export function buildSite({ root, site, sites, channel, buildId, outDir, vendorDir = join(root, 'vendor') }) {
  const registry = readJSON(join(root, 'registry', 'tasks.json'));
  const manifest = readJSON(join(root, 'vendor', 'manifest.json'));
  const dst = join(outDir, site.site);
  rmSync(dst, { recursive: true, force: true });
  const written = [];
  const w = (rel, content) => { put(join(dst, rel), content); written.push(rel); };
  const strings = mergeStrings(root, site.dir);
  for (const s of sites) s.strings = mergeStrings(root, s.dir);
  const templates = {
    page: readFileSync(join(root, 'shared', 'page.html'), 'utf8'),
    main: readFileSync(join(root, existsSync(join(root, site.dir, 'main.html')) ? site.dir : 'shared', 'main.html'), 'utf8'),
  };
  const apps = site.catalog ? readJSON(join(root, 'catalog', 'elffuss-apps.json')).apps : [];
  const storeUrl = channel === 'test' ? TEST_STORE_URL : STORE_ORIGIN + '/';
  const storeOrigin = new URL(storeUrl).origin;
  for (const [p, html] of sitePages({ site, sites, registry, manifest, strings, templates, channel, buildId, storeOrigin, apps })) w(p, html);

  // /v/<id>/: the site's own files, the shared shell and styles, the SDK, the registry.
  const v = `v/${buildId}/`;
  const skip = new Set(['app.json', 'main.html', 'strings.es.json', 'strings.en.json', 'elffuss-apps.json']);
  for (const f of listFiles(join(root, site.dir))) if (!skip.has(f)) w(v + f, { from: join(root, site.dir, f) });
  for (const f of listFiles(join(root, 'shared'))) if (/\.(css|js)$/.test(f)) w(v + 'shared/' + f, { from: join(root, 'shared', f) });
  for (const lang of ['es', 'en']) w(`${v}strings.${lang}.json`, JSON.stringify(strings[lang], null, 2) + '\n');
  for (const f of listFiles(join(root, 'sdk', 'core'))) w(`${v}sdk/core/${f}`, { from: join(root, 'sdk', 'core', f) });
  if (site.task) for (const f of listFiles(join(root, 'sdk', site.task))) w(`${v}sdk/${site.task}/${f}`, { from: join(root, 'sdk', site.task, f) });
  w(`${v}registry/tasks.json`, { from: join(root, 'registry', 'tasks.json') });
  w(`${v}config.js`, configSource({ site, registry, channel, buildId, storeUrl, sites }));
  w(`${v}LICENSES/Apache-2.0.txt`, { from: join(root, 'LICENSES', 'Apache-2.0.txt') });
  w(`${v}LICENSES/MIT-runonweb.txt`, { from: join(root, 'LICENSES', 'MIT-runonweb.txt') });
  // The licences of code a site's own modules adapt (app.json `adapted`).
  for (const a of site.adapted || []) w(`${v}${a.file}`, { from: join(root, ...a.file.split('/')) });
  w(`${v}NOTICE.txt`, { from: join(root, 'NOTICE') });

  // /vendor/: only what this site runs.
  if (!site.catalog) {
    for (const id of Object.values(VENDOR_DIRS)) {
      if (!existsSync(join(vendorDir, id))) throw new Error(`vendor/${id} is missing (the runtimes are not in git): run \`node scripts/vendor.mjs --fetch\``);
    }
    const variant = siteOrtVariant(site, registry);
    const ortId = VENDOR_DIRS.onnxruntimeWeb;
    const ort = manifest.packages[ortId];
    for (const f of Object.values(ORT_VARIANTS[variant])) w(`vendor/${ortId}/${f}`, { from: join(vendorDir, ortId, f) });
    for (const f of Object.keys(ort.licenses)) w(`vendor/${ortId}/${f}`, { from: join(vendorDir, ortId, f) });
    if (siteModels(site, registry).some(m => m.runtime === 'transformers.js')) {
      const tfId = VENDOR_DIRS.transformers;
      const src = readFileSync(join(vendorDir, tfId, 'dist', 'transformers.web.min.js'), 'utf8');
      w(`vendor/${transformersDir(variant)}/transformers.web.min.js`, rewriteTransformers(src, ortSpecifierFromTransformers(variant)));
      // Its licence and those of the libraries its file bundles.
      for (const f of Object.keys(manifest.packages[tfId].licenses)) w(`vendor/${transformersDir(variant)}/${f}`, { from: join(vendorDir, tfId, f) });
    }
    if (site.pdfjs) {
      const pdfId = VENDOR_DIRS.pdfjs;
      const p = manifest.packages[pdfId];
      for (const f of [...Object.keys(p.files), ...Object.keys(p.licenses)]) w(`vendor/${pdfId}/${f}`, { from: join(vendorDir, pdfId, f) });
    }
  }

  // The test channel's smoke page of the SDK core (never in pro or pre).
  if (channel === 'test' && !site.catalog) {
    const pages = join(root, 'tests', 'browser', 'pages');
    for (const f of listFiles(pages)) if (f.endsWith('.js')) w(`${v}__test__/${f}`, { from: join(pages, f) });
    const tpl = readFileSync(join(pages, 'core.html'), 'utf8');
    w('__test__/core.html', tpl.replaceAll('{{base}}', `/${v}`).replace('{{csp}}', csp(site, { storeOrigin, meta: true }).replace(/"/g, '&quot;')));
  }

  // Nothing that could empty, fill or list the store, anywhere in the output.
  for (const rel of written) {
    if (!/\.(html|js|mjs|json)$/.test(rel) || rel.startsWith('vendor/')) continue;
    const text = readFileSync(join(dst, rel), 'utf8');
    for (const bad of FORBIDDEN_IN_BUILD) if (text.includes(bad)) throw new Error(`${site.site}/${rel} contains ${bad}`);
  }
  return written;
}

/** The commit a clean build starts from, extracted to a temporary directory. */
function archiveHead() {
  const dirty = execFileSync(GIT, ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) throw new Error('the working tree is not clean; commit first, or use --dev');
  const id = execFileSync(GIT, ['-C', REPO, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  const tmp = mkdtempSync(join(tmpdir(), 'elffuss-ai-build-'));
  const tar = execFileSync(GIT, ['-C', REPO, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', tmp], { input: tar });
  return { root: tmp, id, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** Parse `<site>|all [--channel c] [--out dir] [--dev]`. */
export function parseArgs(argv) {
  const o = { which: 'all', channel: 'pro', dev: false, outDir: join(REPO, 'dist') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') o.channel = argv[++i];
    else if (a === '--out') o.outDir = argv[++i];
    else if (a === '--dev') o.dev = true;
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else o.which = a;
  }
  if (!['pro', 'pre', 'test'].includes(o.channel)) throw new Error('channel must be pro, pre or test');
  return o;
}

async function main(argv) {
  const { which, channel, dev, outDir } = parseArgs(argv);
  await ensureVendor();
  const src = dev ? { root: REPO, id: 'dev', cleanup: () => {} } : archiveHead();
  try {
    const all = readSites(src.root);
    const chosen = which === 'all' ? all : all.filter(s => s.site === which);
    if (!chosen.length) throw new Error('unknown site ' + which);
    for (const site of chosen) {
      const files = buildSite({ root: src.root, site, sites: all, channel, buildId: src.id, outDir, vendorDir: join(REPO, 'vendor') });
      const bytes = files.reduce((s, f) => s + statSync(join(outDir, site.site, f)).size, 0);
      console.log(`✓ ${site.site}: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB → ${relative(process.cwd(), join(outDir, site.site)) || '.'} (channel ${channel}, build ${src.id})`);
    }
  } finally {
    src.cleanup();
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error('✗ ' + (e.message || e)); process.exitCode = 1; });
}
