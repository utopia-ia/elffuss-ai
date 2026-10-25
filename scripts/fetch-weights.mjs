#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Fills the local weight cache the browser tests serve from, so a run does not
// download hundreds of megabytes again. Every file of registry/tasks.json is
// fetched once from its pinned URL and kept only if its size and hash are the
// registry's (SHA-256 for LFS files, git blob SHA-1 for the small ones).
//
//   ELFFUSS_AI_CACHE=<dir> node scripts/fetch-weights.mjs [--only <model-id>] [--verify]
//
// Layout: $ELFFUSS_AI_CACHE/hf/<owner>/<repo>/<commit>/<path>. Nothing here is
// committed and nothing is ever served outside the test harness.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pinnedUrl } from '../sdk/core/hub-url.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where a pinned file lives in the cache. */
export function cachePath(cache, repo, revision, path) {
  return join(cache, 'hf', ...repo.split('/'), revision, ...path.split('/'));
}

/** Hash a file the way the registry pins it. */
export async function hashFile(file, meta) {
  const { createReadStream } = await import('node:fs');
  const h = createHash(meta.sha256 ? 'sha256' : 'sha1');
  if (!meta.sha256) h.update(`blob ${statSync(file).size}\0`);
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** True when the cached copy has the pinned size and hash (a marker avoids re-hashing). */
export async function isGood(file, meta, { rehash = false } = {}) {
  if (!existsSync(file) || statSync(file).size !== meta.size) return false;
  const marker = file + '.verified';
  const want = meta.sha256 || meta.gitOid;
  if (!rehash && existsSync(marker) && readFileSync(marker, 'utf8').trim() === want) return true;
  const got = await hashFile(file, meta);
  if (got !== want) return false;
  writeFileSync(marker, want + '\n');
  return true;
}

async function download(url, dest, meta) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  rmSync(tmp, { force: true });
  const r = await fetch(url, { headers: { 'user-agent': 'elffuss-ai-test-cache' } });
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(tmp));
  if (statSync(tmp).size !== meta.size) throw new Error(`${url}: ${statSync(tmp).size} bytes, the registry says ${meta.size}`);
  const got = await hashFile(tmp, meta);
  if (got !== (meta.sha256 || meta.gitOid)) throw new Error(`${url}: hash differs from the registry`);
  renameSync(tmp, dest);
  writeFileSync(dest + '.verified', (meta.sha256 || meta.gitOid) + '\n');
}

async function main(argv) {
  const cache = process.env.ELFFUSS_AI_CACHE;
  if (!cache) { console.error('set ELFFUSS_AI_CACHE to the cache directory (never inside the repo)'); return 2; }
  if (cache.startsWith(ROOT)) { console.error('ELFFUSS_AI_CACHE must be outside the repo'); return 2; }
  const reg = JSON.parse(readFileSync(join(ROOT, 'registry', 'tasks.json'), 'utf8'));
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const rehash = argv.includes('--verify');
  let fetched = 0, kept = 0, bytes = 0;
  for (const [id, m] of Object.entries(reg.models)) {
    if (only && id !== only) continue;
    for (const p of Object.values(m.parts)) {
      for (const [path, meta] of Object.entries(p.files)) {
        const dest = cachePath(cache, p.repo, p.revision, path);
        if (await isGood(dest, meta, { rehash })) { kept++; continue; }
        const url = pinnedUrl(p.repo, p.revision, path);
        process.stdout.write(`↓ ${p.repo}/${path} (${(meta.size / 1e6).toFixed(1)} MB)… `);
        await download(url, dest, meta);
        fetched++; bytes += meta.size;
        console.log('ok');
      }
    }
  }
  console.log(`weights: ${kept} already cached and verified, ${fetched} downloaded (${(bytes / 1e6).toFixed(1)} MB)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error('\n✗ ' + (e.message || e)); process.exitCode = 1; });
}
