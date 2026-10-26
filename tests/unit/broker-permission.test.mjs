// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The model store's rule for the tool sites (the copy in tests/fixtures/broker/)
// matches this repo: it accepts exactly the sites' hosts and exactly the files of
// the registry's variants, each with its size (the block broker-repos.mjs prints);
// it refuses every other file, commit or repo, any other size, and the traversal
// forms that would land in another repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { permissionBlocks } from '../../scripts/make-broker-fixture.mjs';
import { filesBlock, hostsLine } from '../../scripts/broker-repos.mjs';
import { toolFiles, registryUrls } from '../../sdk/core/registry.js';
import { HUB_ORIGIN } from '../../sdk/core/hub-url.js';
import { siteHosts } from '../../deploy/sites.mjs';

const reg = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
const blocks = permissionBlocks();
const ctx = vm.createContext({ Map, Number, String });
vm.runInContext(blocks.join('\n') + '\nthis.r = { HERRAMIENTAS, FICHEROS_HERRAMIENTAS, permisoHerramienta };', ctx);
const { HERRAMIENTAS, FICHEROS_HERRAMIENTAS, permisoHerramienta } = ctx.r;
const alternation = re => /\(([^()]*)\)/.exec(re.source)[1].split('|').map(s => s.replace(/\\(.)/g, '$1')).sort();

test('the copy holds the two blocks', () => {
  assert.equal(blocks.length, 2);
});

test('the store lists exactly the files of the registry variants with their sizes, as broker-repos.mjs prints them', () => {
  const want = toolFiles(reg);
  assert.deepEqual([...FICHEROS_HERRAMIENTAS].map(([url, size]) => ({ url, size })), want);
  assert.ok(blocks[1].includes(filesBlock(reg)), 'the block is the printed one, byte for byte');
  assert.ok(want.length >= 15);
});

test('the store accepts exactly the hosts of the sites', () => {
  const hosts = siteHosts().map(h => 'https://' + h);
  for (const h of hosts) assert.ok(HERRAMIENTAS.test(h), h);
  assert.deepEqual(alternation(HERRAMIENTAS).map(s => `https://${s}.elffuss.com`).sort(), [...hosts].sort());
  for (const bad of ['http://ocr.elffuss.com', 'https://ocr.elffuss.utopiaia.com', 'https://x.ocr.elffuss.com', 'https://ocr.elffuss.com:8443', 'https://ocr2.elffuss.com']) assert.equal(HERRAMIENTAS.test(bad), false, bad);
  assert.deepEqual(alternation(new RegExp(hostsLine(siteHosts()).match(/\/(\^.*\$)\//)[1])).sort(), alternation(HERRAMIENTAS));
});

test('every listed file passes with its size: has, get, cancel; any other size is refused', () => {
  for (const { url, size } of toolFiles(reg)) {
    assert.equal(permisoHerramienta('elffuss-model-has', url, size), true, url);
    assert.equal(permisoHerramienta('elffuss-model-has', url), true, 'has without a size takes the listed one');
    assert.equal(permisoHerramienta('elffuss-model-get', url, size), true, url);
    assert.equal(permisoHerramienta('elffuss-model-get', url), false, 'get needs the size');
    for (const wrong of [1, size - 1, size + 1, size + 0.5, 0, -size]) {
      assert.equal(permisoHerramienta('elffuss-model-get', url, wrong), false, `get ${wrong}`);
      assert.equal(permisoHerramienta('elffuss-model-has', url, wrong), false, `has ${wrong}`);
    }
    assert.equal(permisoHerramienta('elffuss-model-cancel', url), true);
    for (const t of ['elffuss-model-put', 'elffuss-model-clear', 'elffuss-broker-diag']) assert.equal(permisoHerramienta(t, url, size), false, t);
  }
});

test('other files and commits of the same repos, other repos and traversal forms are refused', () => {
  const listed = new Set(toolFiles(reg).map(f => f.url));
  const others = registryUrls(reg).filter(u => !listed.has(u.url));
  assert.ok(others.length > 0, 'the registry pins files no variant uses (README.md and the like)');
  for (const { url, size } of others) assert.equal(permisoHerramienta('elffuss-model-get', url, size), false, url);
  const sha = reg.models['ocr/pp-ocrv6-small'].parts.det.revision;
  const base = `${HUB_ORIGIN}/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/${sha}`;
  const bad = [
    `${base}/../../../../other/big-repo/resolve/${'main'}/weights.bin`,
    `${base}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/other/big-repo/resolve/${'main'}/weights.bin`,
    `${base}/..\\..\\..\\..\\other/big-repo/resolve/${'main'}/weights.bin`,
    `${base}/.git/config`,
    `${HUB_ORIGIN}/other/big-repo/resolve/${sha}/weights.bin`,
    `${base}/inference.onnx?x=1`,
    `${HUB_ORIGIN}/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/${'0'.repeat(40)}/inference.onnx`,
    `${HUB_ORIGIN}/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/${'main'}/inference.onnx`,
  ];
  for (const u of bad) assert.equal(permisoHerramienta('elffuss-model-get', u, 9880512), false, u);
});
