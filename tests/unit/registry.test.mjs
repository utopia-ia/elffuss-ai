// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// registry/tasks.json, without the network: shape, pins, hashes, sizes, licences,
// model-store keys, and the generated sizes.js of each task.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sizesSource, serialise, ALLOWED_LICENSES, DENY_REPOS, DENY_LICENSES, MAX_KEY } from '../../scripts/build-registry.mjs';
import { getModel, defaultModelId, resolveRef, variantFiles, findFile, registryRepos, registryUrls } from '../../sdk/core/registry.js';
import { PINNED_URL_RE, storeKey } from '../../sdk/core/hub-url.js';

const root = new URL('../../', import.meta.url);
const text = readFileSync(new URL('registry/tasks.json', root), 'utf8');
const reg = JSON.parse(text);

test('stable serialisation: the committed file is what the generator writes', () => {
  assert.equal(serialise(reg), text);
});

test('each task has a default model of that task', () => {
  assert.deepEqual(Object.keys(reg.tasks).sort(), ['depth', 'detect', 'ocr', 'remove-bg']);
  for (const task of Object.keys(reg.tasks)) {
    const id = defaultModelId(reg, task);
    assert.equal(getModel(reg, id).task, task);
    assert.ok(id.startsWith(task + '/'));
  }
});

test('every part is pinned to a 40-hex commit; every file has a size and exactly one hash', () => {
  for (const [id, m] of Object.entries(reg.models)) {
    for (const [pn, p] of Object.entries(m.parts)) {
      assert.match(p.revision, /^[0-9a-f]{40}$/, `${id}/${pn}`);
      for (const [path, f] of Object.entries(p.files)) {
        assert.ok(f.size > 0, `${p.repo}/${path}`);
        assert.equal(Boolean(f.sha256) + Boolean(f.gitOid), 1, `${p.repo}/${path} needs exactly one hash`);
        if (f.sha256) assert.match(f.sha256, /^[0-9a-f]{64}$/);
        if (f.gitOid) assert.match(f.gitOid, /^[0-9a-f]{40}$/);
        if (/\.onnx(_data)?$/.test(path)) assert.ok(f.sha256, `${path}: weights are LFS files`);
      }
    }
  }
});

test('every variant file exists in its part and the variant bytes add up', () => {
  for (const [id, m] of Object.entries(reg.models)) {
    assert.ok(Object.keys(m.devices).length > 0, id);
    for (const [dev, variants] of Object.entries(m.devices)) {
      assert.ok(['webgpu', 'wasm'].includes(dev), `${id}: unknown device ${dev}`);
      for (const v of variants) {
        const files = variantFiles(m, v);
        assert.equal(files.reduce((s, f) => s + f.size, 0), v.bytes, `${id}/${dev}/${v.dtype}`);
        if (v.when) assert.equal(v.when, 'shader-f16');
      }
    }
  }
});

test('licences are allowed, nothing is on the deny list, nothing is redistributed', () => {
  for (const [id, m] of Object.entries(reg.models)) {
    for (const l of m.license.split(' AND ')) assert.ok(ALLOWED_LICENSES.includes(l), `${id}: ${l}`);
    assert.ok(ALLOWED_LICENSES.includes(m.base.license), `${id}: base ${m.base.license}`);
    for (const p of Object.values(m.parts)) {
      assert.ok(!DENY_REPOS.some(re => re.test(p.repo)), p.repo);
      assert.ok(!DENY_LICENSES.some(re => re.test(p.license)), p.license);
    }
    assert.equal(m.redistributes, false, id);
    assert.equal(m.flag, null, id);
    assert.ok(m.base.name && m.base.author && /^https:\/\//.test(m.base.url), id);
    assert.ok('es' in m.notes && 'en' in m.notes, id);
    assert.ok(m.name.es && m.name.en, id);
  }
});

test('pinned URLs pass the model-store rule and their keys are never cut', () => {
  const urls = registryUrls(reg);
  assert.ok(urls.length > 0);
  for (const { url } of urls) {
    assert.match(url, PINNED_URL_RE);
    const full = url.replace(/[^\w.\-]+/g, '_');
    assert.ok(full.length <= MAX_KEY, `${url}: key of ${full.length} characters`);
    assert.equal(storeKey(url), full);
  }
  // Two different URLs never share a key.
  assert.equal(new Set(urls.map(u => storeKey(u.url))).size, urls.length);
});

test('findFile and resolveRef agree; files outside the pinned commit are not found', () => {
  for (const m of Object.values(reg.models)) {
    for (const [pn, p] of Object.entries(m.parts)) {
      for (const path of Object.keys(p.files)) {
        const hit = findFile(m, p.repo, p.revision, path);
        assert.equal(hit.part, pn);
        assert.deepEqual(hit.file, resolveRef(m, `${pn}:${path}`));
      }
      assert.equal(findFile(m, p.repo, p.revision, 'not/here.bin'), null);
      assert.equal(findFile(m, p.repo, 'f'.repeat(40), Object.keys(p.files)[0]), null);
    }
  }
  assert.throws(() => getModel(reg, 'depth/none'), { code: 'not-in-registry' });
  assert.throws(() => resolveRef(getModel(reg, 'depth/depth-anything-v2-small'), 'main:onnx/model_q4.onnx'), { code: 'not-in-registry' });
});

test('sizes.js of each task is generated from tasks.json', () => {
  for (const task of Object.keys(reg.tasks)) {
    const committed = readFileSync(new URL(`sdk/${task}/sizes.js`, root), 'utf8');
    assert.equal(committed, sizesSource(reg, task), `sdk/${task}/sizes.js`);
  }
});

test('the registry pins five repos', () => {
  assert.equal(registryRepos(reg).length, 5);
});
