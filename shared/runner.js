// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The one retry a site may make, which the SDK never makes on its own: with
// device 'auto', a run that fails on WebGPU is repeated once on WebAssembly, in a
// new task (so a new Worker), and the result says so with `fallback`. With an
// explicit device, after a cancel, or when the failure is the store's or the
// file's, there is no second attempt.

import { toAiError } from '../sdk/core/errors.js';

/** Failures a second backend cannot fix. */
const FINAL = new Set(['aborted', 'integrity', 'not-in-registry', 'runtime-mismatch', 'disposed', 'decode-failed', 'unsupported-format', 'too-large']);

/**
 * @param {{ requested: 'auto'|'webgpu'|'wasm', factory: (opts: object) => any, options: (device: string) => object, onDevice?: (device: string, fallback: object|null) => void }} o
 */
export function createTaskRunner({ requested, factory, options, onDevice }) {
  let task = null;
  let device = requested;
  const make = () => (task ||= factory(options(device)));
  return {
    get task() { return task; },
    /** Run once; on a WebGPU failure with 'auto', once more on WebAssembly. */
    async run(input, opts = {}) {
      const tk = make();
      try {
        const result = await tk.run(input, opts);
        onDevice?.(tk.device, null);
        return { result, device: tk.device, fallback: null };
      } catch (err) {
        const e = toAiError(err);
        if (requested !== 'auto' || device !== 'auto' || tk.device !== 'webgpu' || FINAL.has(e.code) || e.code.startsWith('store-')) throw e;
        await tk.dispose();
        task = null;
        device = 'wasm';
        const again = make();
        const result = await again.run(input, opts);
        const fallback = { from: 'webgpu', reason: e.code };
        onDevice?.(again.device, fallback);
        return { result, device: again.device, fallback };
      }
    },
    async dispose() { const tk = task; task = null; await tk?.dispose(); },
  };
}
