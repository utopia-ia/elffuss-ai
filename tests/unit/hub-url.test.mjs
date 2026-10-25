// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Pinned Hugging Face URLs: what is accepted, and the traversal forms that would
// land in another repository once the URL is normalised.
// This is the one test that may spell the branch revision of the Hub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pinnedUrl, parsePinnedUrl, parseResolveUrl, isHubUrl, storeKey, isSafePath, PINNED_URL_RE, HUB_ORIGIN } from '../../sdk/core/hub-url.js';

const SHA = '28fe5895c24fd108c19eb3e8479f4ab385fbfc62';
const REPO = 'PaddlePaddle/PP-OCRv6_small_det_onnx';
const OK = `${HUB_ORIGIN}/${REPO}/resolve/${SHA}/inference.onnx`;

test('pinnedUrl builds what parsePinnedUrl splits', () => {
  assert.equal(pinnedUrl(REPO, SHA, 'inference.onnx'), OK);
  assert.deepEqual(parsePinnedUrl(OK), { repo: REPO, revision: SHA, path: 'inference.onnx' });
  assert.deepEqual(parsePinnedUrl(`${HUB_ORIGIN}/a/b/resolve/${SHA}/onnx/model_fp16.onnx`), { repo: 'a/b', revision: SHA, path: 'onnx/model_fp16.onnx' });
});

test('pinnedUrl refuses branch names, short shas and unsafe paths', () => {
  assert.throws(() => pinnedUrl(REPO, 'main', 'x'));
  assert.throws(() => pinnedUrl(REPO, SHA.slice(0, 12), 'x'));
  for (const bad of ['../x', 'a/../b', '.git/config', 'a\\b', 'a%2e%2e/b', '', 'a//b', '/abs']) assert.throws(() => pinnedUrl(REPO, SHA, bad), bad);
});

test('traversal, escapes, backslashes, dot segments, queries and other hosts are refused', () => {
  const bad = [
    `${HUB_ORIGIN}/${REPO}/resolve/${SHA}/../../../../other/big-repo/resolve/main/weights.bin`,
    `${HUB_ORIGIN}/${REPO}/resolve/${SHA}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/other/big-repo/resolve/main/weights.bin`,
    `${HUB_ORIGIN}/${REPO}/resolve/${SHA}/..\\..\\..\\..\\other/big-repo/resolve/main/weights.bin`,
    `${HUB_ORIGIN}/${REPO}/resolve/${SHA}/.git/config`,
    `${HUB_ORIGIN}/${REPO}/resolve/${SHA}/inference.onnx?download=1`,
    `${HUB_ORIGIN}/${REPO}/resolve/${SHA}/inference.onnx#x`,
    `${HUB_ORIGIN}/${REPO}/resolve/main/inference.onnx`,
    `https://huggingface.co.evil.net/${REPO}/resolve/${SHA}/inference.onnx`,
    `http://huggingface.co/${REPO}/resolve/${SHA}/inference.onnx`,
  ];
  for (const u of bad) {
    assert.equal(PINNED_URL_RE.test(u), false, u);
    assert.equal(parsePinnedUrl(u), null, u);
  }
  // What URL normalisation would make of the first one: another repo at its branch head.
  assert.equal(new URL(bad[0]).pathname, '/other/big-repo/resolve/main/weights.bin');
});

test('parseResolveUrl reads the branch URLs a runtime builds, and nothing unsafe', () => {
  assert.deepEqual(parseResolveUrl(`${HUB_ORIGIN}/${REPO}/resolve/main/config.json`), { repo: REPO, revision: 'main', path: 'config.json' });
  assert.deepEqual(parseResolveUrl(OK), { repo: REPO, revision: SHA, path: 'inference.onnx' });
  assert.equal(parseResolveUrl(`${HUB_ORIGIN}/${REPO}/resolve/main/../x`), null);
  assert.equal(parseResolveUrl(`${HUB_ORIGIN}/${REPO}/resolve/main/x?y=1`), null);
  assert.equal(parseResolveUrl(`${HUB_ORIGIN}/${REPO}/resolve/ma%2Fin/x`), null);
});

test('store keys and Hub detection', () => {
  assert.equal(storeKey(OK), 'https_huggingface.co_PaddlePaddle_PP-OCRv6_small_det_onnx_resolve_28fe5895c24fd108c19eb3e8479f4ab385fbfc62_inference.onnx');
  assert.equal(storeKey(OK + '?x=1'), storeKey(OK));
  assert.equal(isHubUrl(OK), true);
  assert.equal(isHubUrl('https://example.org/x'), false);
  assert.equal(isSafePath('onnx/model.onnx'), true);
  assert.equal(isSafePath('.gitattributes'), false);
});
