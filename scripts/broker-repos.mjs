#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Prints the lines the model store (the broker page of models.elffuss.com) needs
// to accept the tool sites: the files they may read, each pinned URL with its
// exact size, from registry/tasks.json, and the exact host names, from the site
// list. A unit test compares them with the copy of the broker rule kept in
// tests/fixtures/broker/.
//
//   node scripts/broker-repos.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolFiles } from '../sdk/core/registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The `const FICHEROS_HERRAMIENTAS = new Map([...]);` block for a registry. */
export function filesBlock(registry) {
  const rows = toolFiles(registry).map(f => `  [${JSON.stringify(f.url)}, ${f.size}],`);
  return ['const FICHEROS_HERRAMIENTAS = new Map([', ...rows, ']);'].join('\n');
}

/** The `const HERRAMIENTAS = …;` line for a list of hosts under elffuss.com. */
export function hostsLine(hosts) {
  const subs = hosts.map(h => {
    const m = /^([a-z0-9-]+)\.elffuss\.com$/.exec(h);
    if (!m) throw new Error('not a host under elffuss.com: ' + h);
    return m[1];
  }).sort();
  return `const HERRAMIENTAS = /^https:\\/\\/(${subs.join('|')})\\.elffuss\\.com$/;`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const registry = JSON.parse(readFileSync(join(ROOT, 'registry', 'tasks.json'), 'utf8'));
  console.log(filesBlock(registry));
  try {
    const { siteHosts } = await import('../deploy/sites.mjs');
    console.log(hostsLine(siteHosts()));
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
}
