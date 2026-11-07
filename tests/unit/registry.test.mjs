// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// registry/tasks.json, without the network: shape, pins, hashes, sizes, licences,
// model-store keys, and the generated sizes.js of each task.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { moduleSizesSource, modules, serialise, cardLicense, ALLOWED_LICENSES, ACCEPTED_LICENSES, DENY_REPOS, DENY_LICENSES, MAX_KEY, TASKS } from '../../scripts/build-registry.mjs';
import { getModel, defaultModelId, taskModule, modelBases, resolveRef, variantFiles, findFile, registryRepos, registryUrls, toolFiles } from '../../sdk/core/registry.js';
import { PINNED_URL_RE, storeKey } from '../../sdk/core/hub-url.js';

const root = new URL('../../', import.meta.url);
const text = readFileSync(new URL('registry/tasks.json', root), 'utf8');
const reg = JSON.parse(text);

test('stable serialisation: the committed file is what the generator writes', () => {
  assert.equal(serialise(reg), text);
});

test('each task has a default model of that task', () => {
  assert.deepEqual(Object.keys(reg.tasks).sort(), [...TASKS].sort());
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
  const accepted = Object.values(ACCEPTED_LICENSES);
  for (const [id, m] of Object.entries(reg.models)) {
    for (const l of m.license.split(' AND ')) assert.ok(ALLOWED_LICENSES.includes(l) || accepted.includes(l), `${id}: ${l}`);
    for (const b of modelBases(m)) assert.ok(ALLOWED_LICENSES.includes(b.license) || accepted.includes(b.license), `${id}: base ${b.name} ${b.license}`);
    // A licence taken by name for one model comes with its full text in LICENSES/ and a link.
    if ([m.license, m.base.license].some(l => accepted.includes(l))) {
      assert.ok(m.terms?.some(t => accepted.includes(t.name)), `${id}: the accepted licence is listed in its terms`);
    }
    for (const t of m.terms || []) {
      assert.ok(t.name && /^https:\/\//.test(t.url), `${id}: ${JSON.stringify(t)}`);
      assert.ok(/^LICENSES\/[\w.+-]+\.(md|txt)$/.test(t.file) && existsSync(new URL(t.file, root)), `${id}: ${t.file} is kept in LICENSES/`);
    }
    for (const p of Object.values(m.parts)) {
      assert.ok(!DENY_REPOS.some(re => re.test(p.repo)), p.repo);
      assert.ok(accepted.includes(p.license) || !DENY_LICENSES.some(re => re.test(p.license)), p.license);
    }
    // Two models are conversions published for these sites (redistributed), each in
    // a part that carries its licence and notice. SANA-Sprint's text encoder is
    // Gemma 2, under the Gemma Terms of Use: it says so with its flag.
    const converted = { 'text-to-image/sana-sprint-0.6b': ['onnx', 'gemma-terms'], 'text-to-video/wan2.1-t2v-1.3b-rcm': ['web', null] }[id];
    if (converted) {
      assert.equal(m.redistributes, true, id);
      assert.equal(m.flag, converted[1], id);
      assert.equal(m.parts[converted[0]].author, 'UtopiaIA', id);
      assert.ok(Object.keys(m.parts[converted[0]].files).includes('NOTICE') && Object.keys(m.parts[converted[0]].files).includes('LICENSE'), 'a redistributed conversion carries its licence and notice');
    } else {
      assert.equal(m.redistributes, false, id);
      assert.equal(m.flag, null, id);
    }
    for (const b of modelBases(m)) assert.ok(b.name && b.author && /^https:\/\//.test(b.url), id);
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
  // Two different URLs never share a key (models may share a file: music and sound
  // effects use the same text encoder and decoder, each pinned at one URL).
  const distinct = new Set(urls.map(u => u.url));
  assert.equal(new Set(urls.map(u => storeKey(u.url))).size, distinct.size);
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

test('sizes.js of each module is generated from tasks.json', () => {
  const mods = modules(reg);
  assert.deepEqual(mods.get('audio'), ['text-to-music', 'text-to-sfx', 'text-to-speech']);
  for (const mod of mods.keys()) {
    const committed = readFileSync(new URL(`sdk/${mod}/sizes.js`, root), 'utf8');
    assert.equal(committed, moduleSizesSource(reg, mod), `sdk/${mod}/sizes.js`);
  }
  assert.equal(taskModule(reg, 'image-to-video'), 'video');
  assert.equal(taskModule(reg, 'depth'), 'depth', 'a task without a module lives under its own name');
});

test('a licence outside the allowed list passes only for a model that names it', () => {
  const card = { license: 'other', license_name: 'stable-audio-community' };
  assert.deepEqual(cardLicense(card, ['stable-audio-community']), { license: 'Stability AI Community License', ok: true, accepted: true });
  assert.deepEqual(cardLicense(card, []), { license: 'other', ok: false, accepted: false });
  assert.equal(cardLicense({ license: 'other', license_name: 'some-other' }, ['stable-audio-community']).ok, false);
  assert.equal(cardLicense({ license: 'gemma' }, ['stable-audio-community']).ok, false);
  assert.deepEqual(cardLicense({ license: 'mit' }), { license: 'MIT', ok: true, accepted: false });
});

test('the registry pins fifteen repos', () => {
  assert.equal(registryRepos(reg).length, 15);
});

test('a model that joins several works credits each, and each names a part it has', () => {
  for (const [id, m] of Object.entries(reg.models)) {
    if (!m.bases) continue;
    assert.ok(m.bases.length > 1, `${id}: bases only when there are several`);
    assert.deepEqual(m.base, (({ part, ...b }) => b)(m.bases[0]), `${id}: base is the first of bases`);
    for (const b of m.bases) assert.ok(m.parts[b.part], `${id}: ${b.name} names part ${b.part}`);
  }
  const v = getModel(reg, 'image-to-video/depth-parallax');
  assert.deepEqual(v.bases.map(b => [b.name, b.license]), [['Depth Anything V2 Small', 'Apache-2.0'], ['MI-GAN', 'MIT']]);
});

test('a part two models share is one file of the store: same URLs, listed once', () => {
  const urls = registryUrls(reg).map(u => u.url);
  assert.equal(new Set(urls).size, urls.length, 'registryUrls lists each URL once');
  const tool = toolFiles(reg).map(f => f.url);
  assert.equal(new Set(tool).size, tool.length, 'toolFiles lists each URL once');
  const depth = variantFiles(getModel(reg, 'depth/depth-anything-v2-small'), getModel(reg, 'depth/depth-anything-v2-small').devices.wasm[0]).map(f => f.url);
  const video = variantFiles(getModel(reg, 'image-to-video/depth-parallax'), getModel(reg, 'image-to-video/depth-parallax').devices.wasm[0]).map(f => f.url);
  for (const u of depth.filter(u => /\.onnx$|preprocessor/.test(u))) assert.ok(video.includes(u), `the video model reuses ${u}`);
});
