// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Headers and texts: the nginx files are what deploy/headers.mjs generates, the
// policies carry every directive and nothing unsafe, only detect may use the
// camera; every text exists in both languages with the same placeholders, every
// error code and status has a text, and no text speaks of hardware or times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { check as nginxCheck } from '../../deploy/build-nginx.mjs';
import { csp, permissionsPolicy, headersFor, STORE_ORIGIN } from '../../deploy/headers.mjs';
import { sites as readSites } from '../../deploy/sites.mjs';
import { mergeStrings } from '../../scripts/build.mjs';
import { ERROR_CODES } from '../../sdk/core/errors.js';
import { STATUSES } from '../../sdk/core/progress.js';
import { staticRules, sweepText } from '../../scripts/sweep.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sites = readSites(ROOT);

test('deploy/nginx/ is exactly what deploy/headers.mjs generates', () => {
  assert.deepEqual(nginxCheck(), []);
});

test('every policy has every directive, the store as the only frame, nothing unsafe', () => {
  const need = ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'worker-src', 'frame-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors', 'manifest-src', 'require-trusted-types-for', 'trusted-types'];
  for (const s of sites) {
    const p = csp(s);
    const d = Object.fromEntries(p.split('; ').map(x => [x.split(' ')[0], x.split(' ').slice(1).join(' ')]));
    assert.deepEqual(Object.keys(d).sort(), [...need].sort(), s.site);
    assert.doesNotMatch(p, /'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'|\*/, s.site);
    for (const k of ['object-src', 'base-uri', 'form-action', 'frame-ancestors']) assert.equal(d[k], "'none'", `${s.site} ${k}`);
    assert.equal(d['frame-src'], STORE_ORIGIN, `${s.site} frame-src`);
    assert.equal(d['connect-src'], "'self'", `${s.site} connect-src`);
    assert.equal(d['require-trusted-types-for'], "'script'", s.site);
    if (s.catalog) { assert.equal(d['script-src'], "'self'"); assert.equal(d['worker-src'], "'none'"); assert.equal(d['trusted-types'], "'none'"); }
    else { assert.equal(d['script-src'], "'self' 'wasm-unsafe-eval'"); assert.equal(d['worker-src'], "'self'"); assert.equal(d['trusted-types'], 'elffuss-ai'); }
    assert.doesNotMatch(csp(s, { meta: true }), /frame-ancestors/, 'a <meta> cannot carry frame-ancestors');
  }
});

test('only detect may use the camera; nothing else is allowed anywhere', () => {
  for (const s of sites) {
    const pp = permissionsPolicy(s);
    assert.equal(pp.includes('camera=(self)'), s.site === 'detect', s.site);
    for (const f of ['microphone', 'geolocation', 'usb', 'serial', 'hid', 'bluetooth', 'payment', 'display-capture', 'browsing-topics']) assert.ok(pp.includes(`${f}=()`), `${s.site} ${f}`);
    const h = Object.fromEntries(headersFor(s, { kind: 'beta' }));
    assert.equal(h['X-Robots-Tag'], 'noindex');
    assert.equal(h['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.equal(h['X-Frame-Options'], 'DENY');
    assert.equal(Object.fromEntries(headersFor(s, { kind: 'vendor' }))['Cache-Control'], 'public, max-age=31536000, immutable');
  }
});

const placeholders = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('every text exists in both languages, with the same placeholders', () => {
  for (const s of sites) {
    const m = mergeStrings(ROOT, s.dir);
    assert.deepEqual(Object.keys(m.es).sort(), Object.keys(m.en).sort(), s.site);
    for (const k of Object.keys(m.es)) {
      assert.deepEqual(placeholders(m.es[k]), placeholders(m.en[k]), `${s.site} ${k}`);
      assert.ok(m.es[k] && m.en[k], `${s.site} ${k} is empty`);
    }
    const own = JSON.parse(readFileSync(join(ROOT, s.dir, 'strings.es.json'), 'utf8'));
    const need = s.catalog ? ['title', 'description', 'intro', 'section.tools', 'section.apps', 'card.model', 'card.stored'] : ['title', 'description', 'intro', 'drop', 'action.run', 'action.downloadAndRun', 'catalog.name', 'catalog.line'];
    for (const k of need) assert.ok(k in own, `${s.site}: needs ${k}`);
    if (!s.catalog) assert.deepEqual(placeholders(own['action.downloadAndRun']), ['size'], `${s.site}: the download label takes {size}`);
  }
});

test('every error code and progress status has a text', () => {
  for (const lang of ['es', 'en']) {
    const t = JSON.parse(readFileSync(join(ROOT, 'shared', `strings.${lang}.json`), 'utf8'));
    for (const c of ERROR_CODES) assert.ok(t['error.' + c], `${lang}: error.${c}`);
    for (const st of STATUSES) assert.ok(t['status.' + st], `${lang}: status.${st}`);
    assert.equal(t['privacy.download'], lang === 'es' ? 'Se descarga la primera vez y se guarda en este navegador.' : 'It is downloaded the first time and kept in this browser.');
  }
});

test('no text speaks of hardware, memory, times or internal names', () => {
  const rules = staticRules().filter(r => ['hardware', 'memory', 'timing', 'internal'].includes(r.id));
  for (const s of sites) {
    const m = mergeStrings(ROOT, s.dir);
    for (const lang of ['es', 'en']) for (const [k, v] of Object.entries(m[lang])) assert.deepEqual(sweepText(String(v), '.md', rules), [], `${s.site} ${lang} ${k}`);
  }
});
