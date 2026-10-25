// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// transformers.web.min.js does not carry ONNX Runtime: it imports it by package
// name. Without a bundler, pinning ONNX Runtime means pointing those two imports
// at the vendored bundle. Both go to the same bundle, which exports Tensor, so
// the page has a single Tensor class. Nothing else in the file changes, and this
// function proves it by undoing the change and comparing.

/** The two import clauses of transformers.web.min.js 4.3.1 that name ONNX Runtime. */
export const ORT_IMPORTS = Object.freeze(['from"onnxruntime-web/webgpu"', 'from"onnxruntime-common"']);

/**
 * Rewrite the two ONNX Runtime imports of the minified Transformers.js.
 * @param {string} src the original file
 * @param {string} specifier relative import specifier of the ONNX Runtime bundle
 * @returns {string}
 */
export function rewriteTransformers(src, specifier) {
  if (!/^\.\.?\/[\w@.+\-/]+\.mjs$/.test(specifier)) throw new Error('unexpected specifier: ' + specifier);
  if (src.includes(specifier)) throw new Error('the specifier already appears in the source');
  let out = src;
  for (const clause of ORT_IMPORTS) {
    const n = out.split(clause).length - 1;
    if (n !== 1) throw new Error(`expected exactly one ${clause}, found ${n}`);
    out = out.replace(clause, `from"${specifier}"`);
  }
  // Undo and compare: nothing but the two clauses may differ.
  const parts = out.split(`from"${specifier}"`);
  if (parts.length !== 3) throw new Error('rewrite produced an unexpected number of imports');
  const back = parts[0] + ORT_IMPORTS[0] + parts[1] + ORT_IMPORTS[1] + parts[2];
  if (back !== src) throw new Error('rewrite changed more than the two imports');
  return out;
}
