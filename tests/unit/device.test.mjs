// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Backend and variant choice: the registry's devices against every probe result,
// with 'auto' and with an explicit backend. The SDK never switches on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseVariant, probeWebGPU, ortVariantFor, threadCount, isShaderError } from '../../sdk/core/device.js';

const reg = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
const m = id => reg.models[id];
const F16 = { available: true, shaderF16: true, fallbackAdapter: false };
const NOF16 = { available: true, shaderF16: false, fallbackAdapter: false };
const NONE = { available: false, shaderF16: false, fallbackAdapter: false, reason: 'no-adapter' };

test('depth: WebGPU fp16 with shader-f16, fp32 without, WebAssembly q8 with no adapter', () => {
  const d = m('depth/depth-anything-v2-small');
  assert.deepEqual([chooseVariant(d, 'auto', F16).device, chooseVariant(d, 'auto', F16).dtype], ['webgpu', 'fp16']);
  assert.deepEqual([chooseVariant(d, 'auto', NOF16).device, chooseVariant(d, 'auto', NOF16).dtype], ['webgpu', 'fp32']);
  assert.deepEqual([chooseVariant(d, 'auto', NONE).device, chooseVariant(d, 'auto', NONE).dtype], ['wasm', 'q8']);
  assert.equal(chooseVariant(d, 'wasm', F16).dtype, 'q8');
  assert.throws(() => chooseVariant(d, 'webgpu', NONE), { code: 'webgpu-unavailable' });
});

test('cutout and detect: WebAssembly only; asking for WebGPU is device-unsupported', () => {
  for (const id of ['remove-bg/ben2', 'detect/rfdetr-nano']) {
    for (const probe of [F16, NOF16, NONE]) assert.equal(chooseVariant(m(id), 'auto', probe).device, 'wasm', id);
    assert.throws(() => chooseVariant(m(id), 'webgpu', F16), { code: 'device-unsupported' });
  }
  assert.equal(chooseVariant(m('remove-bg/ben2'), 'auto', F16).dtype, 'fp16');
  assert.equal(chooseVariant(m('detect/rfdetr-nano'), 'auto', F16).dtype, 'q8');
});

test('ocr: same fp32 files on both backends', () => {
  const o = m('ocr/pp-ocrv6-small');
  assert.equal(chooseVariant(o, 'auto', NOF16).device, 'webgpu');
  assert.equal(chooseVariant(o, 'auto', NONE).device, 'wasm');
  assert.deepEqual(chooseVariant(o, 'webgpu', F16).variant.files, chooseVariant(o, 'wasm', F16).variant.files);
});

test('unknown requests are refused', () => {
  assert.throws(() => chooseVariant(m('ocr/pp-ocrv6-small'), 'gpu', F16), { code: 'device-unsupported' });
});

test('the probe only accepts a real adapter', async () => {
  const fake = (adapter) => ({ requestAdapter: async () => adapter });
  assert.equal((await probeWebGPU({ gpu: null })).available, false);
  assert.equal((await probeWebGPU({ gpu: fake(null) })).reason, 'no-adapter');
  assert.equal((await probeWebGPU({ gpu: fake({ info: { isFallbackAdapter: true }, features: new Set() }) })).reason, 'fallback-adapter');
  const ok = await probeWebGPU({ gpu: fake({ info: { isFallbackAdapter: false }, features: new Set(['shader-f16']) }) });
  assert.deepEqual(ok, { available: true, shaderF16: true, fallbackAdapter: false });
  assert.equal((await probeWebGPU({ gpu: { requestAdapter: async () => { throw new Error('x'); } } })).reason, 'adapter-error');
});

test('ONNX Runtime variant per site, threads and shader errors', () => {
  assert.equal(ortVariantFor([m('depth/depth-anything-v2-small')]), 'webgpu');
  assert.equal(ortVariantFor([m('ocr/pp-ocrv6-small')]), 'webgpu');
  assert.equal(ortVariantFor([m('remove-bg/ben2')]), 'wasm');
  assert.equal(ortVariantFor([m('detect/rfdetr-nano')]), 'wasm');
  assert.equal(threadCount({ isolated: false, cores: 16 }), 1);
  assert.ok(threadCount({ isolated: true, cores: 16 }) > 1);
  assert.equal(isShaderError(new Error('Invalid ShaderModule "LayerNorm"')), true);
  assert.equal(isShaderError(new Error('out of memory')), false);
});
