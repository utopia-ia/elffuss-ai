// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The one retry a site may make, which the SDK never makes on its own: with
// device 'auto', a run that fails on WebGPU is repeated once on WebAssembly, in a
// new task (so a new Worker), and the result says so with `fallback`. With an
// explicit device, after a cancel, or when the failure is the store's or the
// file's, there is no second attempt.
//
// The backend of an attempt is read once the task is loaded and before it runs:
// a task whose run fails in a Worker drops its Worker and, with it, what it
// loaded, so its `device` is empty by the time the failure arrives. The retry
// belongs to the same run, so the test hooks that break a first run or load
// (test builds only) do not apply to it.

import { toAiError } from '../sdk/core/errors.js';

/** Failures a second backend cannot fix. */
const FINAL = new Set(['aborted', 'integrity', 'not-in-registry', 'runtime-mismatch', 'disposed', 'decode-failed', 'unsupported-format', 'too-large']);

/** Options for the retry: the same, without the hooks that break a first run or load. */
export function retryOptions(opts) {
  if (!opts?.test) return opts;
  return { ...opts, test: { ...opts.test, failRun: false, failLoad: false } };
}

/**
 * @param {{ requested: 'auto'|'webgpu'|'wasm', factory: (opts: object) => any, options: (device: string) => object, onDevice?: (device: string, fallback: object|null) => void }} o
 */
export function createTaskRunner({ requested, factory, options, onDevice }) {
  let task = null;
  let device = requested;
  const make = opts => (task ||= factory(opts || options(device)));
  return {
    get task() { return task; },
    /** Run once; on a WebGPU failure with 'auto', once more on WebAssembly. */
    async run(input, opts = {}) {
      const tk = make();
      let used = tk.device ?? null;
      try {
        if (!used && typeof tk.load === 'function') used = (await tk.load({ signal: opts.signal }))?.device ?? tk.device ?? null;
        const result = await tk.run(input, opts);
        const ran = tk.device ?? used;
        onDevice?.(ran, null);
        return { result, device: ran, fallback: null };
      } catch (err) {
        const e = toAiError(err);
        if (requested !== 'auto' || device !== 'auto' || (used ?? tk.device) !== 'webgpu' || FINAL.has(e.code) || e.code.startsWith('store-')) throw e;
        await tk.dispose();
        task = null;
        device = 'wasm';
        const again = make(retryOptions(options(device)));
        const result = await again.run(input, opts);
        const fallback = { from: 'webgpu', reason: e.code };
        onDevice?.(again.device, fallback);
        return { result, device: again.device, fallback };
      }
    },
    async dispose() { const tk = task; task = null; await tk?.dispose(); },
  };
}
