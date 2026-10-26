// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// transformers.web.min.js does not carry ONNX Runtime: it imports it by package
// name. Without a bundler, pinning ONNX Runtime means pointing those two imports
// at the vendored bundle. Both go to the same bundle, which exports Tensor, so
// the page has a single Tensor class. The file served is a modified file, so its
// first line says so (Apache-2.0, section 4(b)). Nothing else in it changes, and
// this function proves it by undoing both changes and comparing.

/** The two import clauses of transformers.web.min.js 4.3.1 that name ONNX Runtime. */
export const ORT_IMPORTS = Object.freeze(['from"onnxruntime-web/webgpu"', 'from"onnxruntime-common"']);

/** The notice the modified file starts with. */
export const MODIFIED_NOTICE = '/*! Modified by UtopiaIA for the Elffuss tools: the two ONNX Runtime imports of this file point at the copy of ONNX Runtime Web served with it. Nothing else is changed. */\n';

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
  out = MODIFIED_NOTICE + out;
  // Undo and compare: nothing but the notice and the two clauses may differ.
  if (!out.startsWith(MODIFIED_NOTICE)) throw new Error('the modified file does not start with its notice');
  const parts = out.slice(MODIFIED_NOTICE.length).split(`from"${specifier}"`);
  if (parts.length !== 3) throw new Error('rewrite produced an unexpected number of imports');
  const back = parts[0] + ORT_IMPORTS[0] + parts[1] + ORT_IMPORTS[1] + parts[2];
  if (back !== src) throw new Error('rewrite changed more than the two imports');
  return out;
}
