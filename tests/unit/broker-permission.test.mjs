// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The model store's rule for the tool sites (the copy in tests/fixtures/broker/)
// matches this repo: it accepts exactly the registry's repos and the sites'
// hosts, lets every pinned file through, and refuses the traversal forms that
// would land in another repository. It also agrees with sdk/core/hub-url.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { permissionBlocks } from '../../scripts/make-broker-fixture.mjs';
import { reposLine, hostsLine } from '../../scripts/broker-repos.mjs';
import { registryRepos, registryUrls } from '../../sdk/core/registry.js';
import { PINNED_URL_RE, HUB_ORIGIN } from '../../sdk/core/hub-url.js';
import { siteHosts } from '../../deploy/sites.mjs';

const reg = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
const blocks = permissionBlocks();
const ctx = vm.createContext({});
vm.runInContext(blocks.join('\n') + '\nthis.r = { HERRAMIENTAS, REPOS_HERRAMIENTAS, HF_FIJADO, permisoHerramienta };', ctx);
const { HERRAMIENTAS, REPOS_HERRAMIENTAS, HF_FIJADO, permisoHerramienta } = ctx.r;
const alternation = re => /\(([^()]*)\)/.exec(re.source)[1].split('|').map(s => s.replace(/\\(.)/g, '$1')).sort();

test('the copy holds the two blocks', () => {
  assert.equal(blocks.length, 2);
});

test('the store accepts exactly the registry repos, and the line is what broker-repos.mjs prints', () => {
  assert.deepEqual(alternation(REPOS_HERRAMIENTAS), registryRepos(reg));
  for (const r of registryRepos(reg)) assert.ok(REPOS_HERRAMIENTAS.test(r), r);
  for (const bad of ['onnx-community/BEN2-ONNX2', 'xonnx-community/BEN2-ONNX', 'PaddlePaddle/PP-OCRv6_medium_rec_onnx', 'onnx-community/depth-anything-v2-large']) assert.equal(REPOS_HERRAMIENTAS.test(bad), false, bad);
  assert.ok(blocks[1].includes(reposLine(reg)));
});

test('the store accepts exactly the hosts of the sites', () => {
  const hosts = siteHosts().map(h => 'https://' + h);
  for (const h of hosts) assert.ok(HERRAMIENTAS.test(h), h);
  assert.deepEqual(alternation(HERRAMIENTAS).map(s => `https://${s}.elffuss.com`).sort(), [...hosts].sort());
  for (const bad of ['http://ocr.elffuss.com', 'https://ocr.elffuss.utopiaia.com', 'https://x.ocr.elffuss.com', 'https://ocr.elffuss.com:8443', 'https://ocr2.elffuss.com']) assert.equal(HERRAMIENTAS.test(bad), false, bad);
  assert.deepEqual(alternation(new RegExp(hostsLine(siteHosts()).match(/\/(\^.*\$)\//)[1])).sort(), alternation(HERRAMIENTAS));
});

test('every pinned file of the registry passes: has, get with its size, cancel', () => {
  for (const { url, size } of registryUrls(reg)) {
    assert.equal(permisoHerramienta('elffuss-model-has', url), true, url);
    assert.equal(permisoHerramienta('elffuss-model-get', url, size), true, url);
    assert.equal(permisoHerramienta('elffuss-model-get', url), false, 'no size');
    assert.equal(permisoHerramienta('elffuss-model-cancel', url), true);
    for (const t of ['elffuss-model-put', 'elffuss-model-clear', 'elffuss-broker-diag']) assert.equal(permisoHerramienta(t, url, size), false, t);
  }
});

test('traversal, escapes, dot segments and foreign repos are refused, as in hub-url.js', () => {
  const sha = reg.models['ocr/pp-ocrv6-small'].parts.det.revision;
  const base = `${HUB_ORIGIN}/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/${sha}`;
  const bad = [
    `${base}/../../../../other/big-repo/resolve/${'main'}/weights.bin`,
    `${base}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/other/big-repo/resolve/${'main'}/weights.bin`,
    `${base}/..\\..\\..\\..\\other/big-repo/resolve/${'main'}/weights.bin`,
    `${base}/.git/config`,
    `${HUB_ORIGIN}/other/big-repo/resolve/${sha}/weights.bin`,
    `${base}/inference.onnx?x=1`,
  ];
  for (const u of bad) assert.equal(permisoHerramienta('elffuss-model-get', u, 10), false, u);
  // The SDK and the store agree on what a pinned URL is.
  for (const u of [...bad, ...registryUrls(reg).map(x => x.url)]) assert.equal(PINNED_URL_RE.test(u), HF_FIJADO.test(u), u);
});
