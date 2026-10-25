// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The WebGPU runs of the browser tests share the machine with other work, so
// they take the machine's coordination lock first and always give it back, also
// on failure or Ctrl-C. The lock script is ELFFUSS_AI_LOCK, by default the one
// in the user's coordination directory; ELFFUSS_AI_LOCK=none runs without it.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PROJECT = 'elffuss-ai';

/** Path of the lock script, or null when locking is turned off. */
export function lockScript() {
  const v = process.env.ELFFUSS_AI_LOCK;
  if (v === 'none') return null;
  const p = v || join(homedir(), '.gpu_coordination', 'gpu-lock.sh');
  if (!existsSync(p)) throw new Error(`no lock script at ELFFUSS_AI_LOCK (${v ? 'as set' : 'default'}); set ELFFUSS_AI_LOCK=none to run WebGPU tests without it`);
  return p;
}

const run = (script, args) => {
  try { return { code: 0, out: execFileSync('bash', [script, ...args], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

/**
 * Take the lock, waiting (never preempting) while someone else holds it.
 * @param {{ job: string, pid?: number, wait?: number, poll?: number, log?: (s: string) => void }} o
 * @returns {Promise<{ release(): void }>}
 */
export async function acquire({ job, pid = process.pid, wait = 30 * 60 * 1000, poll = 15000, log = s => console.log(s) }) {
  const script = lockScript();
  if (!script) return { release() {} };
  const t0 = Date.now();
  let queued = false;
  for (;;) {
    const r = run(script, ['acquire', PROJECT, 'normal', job, String(pid)]);
    if (r.code === 0) break;
    if (!queued) { run(script, ['request', PROJECT, 'normal', job]); queued = true; log(`waiting for the coordination lock: ${r.out.trim()}`); }
    if (Date.now() - t0 > wait) throw new Error('the coordination lock was not free in time');
    await new Promise(res => setTimeout(res, poll));
  }
  let released = false;
  const release = () => { if (!released) { released = true; run(script, ['release', PROJECT]); } };
  const onSignal = sig => { release(); process.exit(sig === 'SIGINT' ? 130 : 143); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', release);
  return {
    release() { release(); process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); },
    /** True when a higher-priority project asks for the lock: stop between sites. */
    shouldYield() { return run(script, ['should-yield', PROJECT]).code === 0; },
  };
}
