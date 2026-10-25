// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The deploy scripts: one per site and no other, all through the shared one,
// which takes the server from the environment, refuses a dirty tree and the
// weekday window, sweeps the build, and never syncs with --delete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sites as readSites } from '../../deploy/sites.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('one deploy script per site, each calling the shared one with its name', () => {
  const sites = readSites(ROOT).map(s => s.site).sort();
  const scripts = readdirSync(join(ROOT, 'deploy')).filter(f => /^deploy-.*\.sh$/.test(f)).map(f => f.slice(7, -3)).sort();
  assert.deepEqual(scripts, sites);
  for (const s of sites) {
    const p = join(ROOT, 'deploy', `deploy-${s}.sh`);
    assert.ok(statSync(p).mode & 0o111, `${p} is executable`);
    assert.match(readFileSync(p, 'utf8'), new RegExp(`exec "\\$\\(dirname "\\$0"\\)/lib/deploy-site\\.sh" ${s} "\\$@"`));
  }
});

test('the shared deploy keeps its promises', () => {
  const sh = readFileSync(join(ROOT, 'deploy', 'lib', 'deploy-site.sh'), 'utf8');
  assert.match(sh, /ELFFUSS_HOST:\?/);
  assert.match(sh, /ELFFUSS_KEY:\?/);
  assert.match(sh, /git status --porcelain/);
  assert.match(sh, /"\$HOUR" -ge 8 \] && \[ "\$HOUR" -lt 16 \]/);
  assert.match(sh, /--ignore-window/);
  assert.match(sh, /sweep\.mjs --release --git --dist/);
  assert.match(sh, /node --test/);
  assert.match(sh, /mv -f/);
  const code = sh.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /--delete/);
  assert.doesNotMatch(code, /\bblog\b|\bbeta\/\*/, 'never touches blog/ and never empties beta/');
});
