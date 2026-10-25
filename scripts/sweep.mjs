#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Publication sweep. Nothing leaves the machine without passing it.
//
//   node scripts/sweep.mjs                 tracked and new files of the repo
//   node scripts/sweep.mjs --dist dist     also a built tree
//   node scripts/sweep.mjs --git           also the git metadata (authors, messages)
//   node scripts/sweep.mjs --release       all of the above; needs ELFFUSS_SWEEP_PRIVATE
//   node scripts/sweep.mjs --self-test     every rule against a bait and a clean line
//
// Prints every finding and a count per rule, zeros included. Exit code 1 when
// anything is found: a "clean" without the output on screen does not count.
//
// The rules are written so that the words they hunt do not appear literally in
// this file (a character class splits each one), so the sweep can pass over
// itself without a named exception. Private terms (names, personal addresses)
// never live in the repo: they are read from the file that ELFFUSS_SWEEP_PRIVATE
// points to, one term per line.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';
import { userInfo, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const GIT = '/usr/bin/git';

export const BINARY_EXT = new Set(['.wasm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.pdf', '.onnx',
  '.bcmap', '.pfb', '.ttf', '.otf', '.icc', '.woff', '.woff2', '.ico', '.zip', '.gz', '.tgz', '.y4m', '.heic', '.bmp']);
// Files whose prose is the whole file. In the rest, only comments are prose.
const PROSE_EXT = new Set(['.md', '.txt', '.html', '.json', '']);
const COMMENT_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.sh', '.conf', '.yml', '.yaml']);

/** @typedef {{ id: string, what: string, re: RegExp, scope: 'all'|'prose', bait: string, clean: string }} Rule */

/** Rules that do not depend on the machine. */
export function staticRules() {
  /** @type {Rule[]} */
  const rules = [
    { id: 'user-path', what: 'home or temp paths of a machine', scope: 'all',
      re: /(?:\/Use[r]s\/|\/hom[e]\/|[A-Z]:\\Use[r]s\\|\/priv[a]te\/tmp\/|\/var\/fold[e]rs\/)/,
      bait: ['', 'Users', 'someone', 'x'].join('/'), clean: 'paths stay relative: apps/ocr/app.js' },
    { id: 'hardware', what: 'chip, vendor or device words', scope: 'all',
      re: /\b(?:Appl[e] Silicon|M[a]cBook|M[a]c (?:Studio|mini|Pro)|iM[a]c|M[a]c|macO[S]|Met[a]l|CUD[A]|NVID[I]A|GeFor[c]e|RT[X] ?\d{3,4}|Rade[o]n|AM[D]|Int[e]l|Snapdrag[o]n|Adre[n]o|Neural Engin[e]|M[1-5](?: (?:Pro|Max|Ultra))?)\b/,
      bait: ['runs on a ', 'Ma', 'c'].join(''), clean: 'runs with WebGPU or WebAssembly' },
    { id: 'hardware', what: 'the bare word for a graphics processor (WebGPU is fine)', scope: 'all',
      re: /(?<![A-Za-z])G[P]Us?(?![A-Za-z])/,
      bait: ['on your ', 'G', 'PU'].join(''), clean: 'on WebGPU, navigator.gpu, GPUAdapter' },
    { id: 'memory', what: 'memory or quota amounts', scope: 'all',
      re: /\b\d+(?:[.,]\d+)?\s*(?:[GT]i?B)\b[^\n]{0,40}\b(?:R[A]M|VR[A]M|memory|memoria|quota|cuota|unified|wired|techo|ceiling)\b|\b(?:R[A]M|VR[A]M|memory|memoria|quota|cuota|unified|wired|techo|ceiling)\b[^\n]{0,40}\b\d+(?:[.,]\d+)?\s*[GT]i?B\b/i,
      bait: ['needs 16 ', 'GB of R', 'AM'].join(''), clean: 'the model is a 31 MB download' },
    { id: 'timing', what: 'absolute times or speeds in prose and comments', scope: 'prose',
      re: /\b\d+(?:[.,]\d+)?\s*(?:ms|milliseconds?|milisegundos?|seconds?|segundos?|secs?|minutes?|minutos?|mins?|hours?|horas?)\b|\b\d+(?:[.,]\d+)?\s*(?:tokens?\/s|tok\/s|it\/s|fps)\b/i,
      bait: ['loads in 3 ', 'seconds'].join(''), clean: 'loads once, then it is kept in this browser' },
    { id: 'internal', what: 'internal project names', scope: 'all',
      re: /\bt[2]t\b|token[ -]t[o][ -]token|\bclon[a]gent\b|\butopi[a]-labs\b|\bcl[a]ude\b|\banthr[o]pic\b/i,
      bait: ['the ', 't2', 't network'].join(''), clean: 'the Elffuss tools' },
    { id: 'internal', what: 'internal token name', scope: 'all',
      re: /\bE[L]F\b/,
      bait: ['the ', 'EL', 'F token'].join(''), clean: 'Elffuss, self, shelf' },
    { id: 'internal', what: 'model servers that are not public', scope: 'all',
      re: /\bm[0-9]+\.elffus[s]\.(?:com|utopiaia\.com)\b/i,
      bait: ['https://', 'm1', '.elffuss.com/x'].join(''), clean: 'https://models.elffuss.com/' },
    { id: 'coauthor', what: 'co-author credits', scope: 'all',
      re: /co-autho[r]ed-by/i,
      bait: ['Co-', 'Authored-By: x'].join(''), clean: 'written by the team' },
    { id: 'address', what: 'IPv4 addresses other than loopback', scope: 'all',
      re: /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/,
      bait: ['10', '20', '30', '40'].join('.'), clean: 'listen on 127.0.0.1 only; version 1.30.0' },
  ];
  return rules;
}

/** Rules that depend on this machine: user name, cache path, private terms. */
export function machineRules({ username = userInfo().username, host = hostname(), cachePath = process.env.ELFFUSS_AI_CACHE, privateFile = process.env.ELFFUSS_SWEEP_PRIVATE } = {}) {
  /** @type {Rule[]} */
  const rules = [];
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (username && username.length >= 3) {
    rules.push({ id: 'user-name', what: 'the name of the user running the sweep', scope: 'all',
      re: new RegExp(esc(username), 'i'), bait: 'owner: ' + username, clean: 'owner: UtopiaIA', binary: true });
  }
  const shortHost = String(host || '').replace(/\.(local|lan|home)$/i, '');
  if (shortHost.length >= 4 && shortHost.toLowerCase() !== 'localhost') {
    rules.push({ id: 'host-name', what: 'the name of this machine', scope: 'all',
      re: new RegExp('(?<![A-Za-z0-9])' + esc(shortHost) + '(?![A-Za-z0-9])', 'i'), bait: 'built on ' + shortHost, clean: 'built from a clean tree', binary: true });
  }
  if (cachePath) {
    const generic = new Set(['tmp', 'var', 'opt', 'usr', 'cache']);
    for (const part of cachePath.split(/[\\/]+/).filter(p => p.length >= 4 && !generic.has(p.toLowerCase()))) {
      rules.push({ id: 'cache-path', what: 'a component of ELFFUSS_AI_CACHE', scope: 'all',
        re: new RegExp('(?<![A-Za-z0-9])' + esc(part) + '(?![A-Za-z0-9])', 'i'), bait: 'cache in ' + part, clean: 'cache in $ELFFUSS_AI_CACHE' });
    }
  }
  if (privateFile) {
    if (!existsSync(privateFile)) throw new Error('ELFFUSS_SWEEP_PRIVATE points to a missing file');
    const terms = readFileSync(privateFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    for (const term of terms) {
      rules.push({ id: 'private', what: 'a private term (list kept outside the repo)', scope: 'all',
        re: new RegExp('(?<![A-Za-z0-9])' + esc(term) + '(?![A-Za-z0-9])', 'i'), bait: 'by ' + term, clean: 'by UtopiaIA', binary: true });
    }
  }
  return rules;
}

/** Lines of `text` that count as prose for a file with extension `ext`. */
export function proseOf(text, ext) {
  if (PROSE_EXT.has(ext)) return text;
  if (!COMMENT_EXT.has(ext)) return text;
  // Keep comments, blank out code, preserve line numbers.
  const out = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    let keep = '';
    let rest = line;
    while (rest.length) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end < 0) { keep += rest; rest = ''; } else { keep += rest.slice(0, end); rest = rest.slice(end + 2); inBlock = false; }
        continue;
      }
      const start = rest.indexOf('/*');
      const lineC = (ext === '.sh' || ext === '.conf' || ext === '.yml' || ext === '.yaml') ? rest.search(/(^|\s)#/) : rest.search(/(^|[^:\\])\/\//);
      if (start >= 0 && (lineC < 0 || start < lineC)) { rest = rest.slice(start + 2); inBlock = true; continue; }
      if (lineC >= 0) { keep += rest.slice(lineC); rest = ''; continue; }
      rest = '';
    }
    out.push(keep);
  }
  return out.join('\n');
}

/**
 * Sweep one text. Returns findings `{ rule, line, excerpt }`.
 * @param {string} text
 * @param {string} ext
 * @param {Rule[]} rules
 */
export function sweepText(text, ext, rules) {
  const findings = [];
  const prose = proseOf(text, ext);
  const lines = text.split('\n');
  const proseLines = prose.split('\n');
  for (const rule of rules) {
    const src = rule.scope === 'prose' ? proseLines : lines;
    for (let i = 0; i < src.length; i++) {
      const m = rule.re.exec(src[i]);
      if (m) findings.push({ rule: rule.id, what: rule.what, line: i + 1, excerpt: excerpt(src[i], m.index) });
    }
  }
  return findings;
}

/** Sweep binary bytes for the rules that apply to binaries (user name, private terms). */
export function sweepBinary(buf, rules) {
  const findings = [];
  const latin = buf.toString('latin1');
  const utf16 = buf.toString('utf16le');
  for (const rule of rules.filter(r => r.binary)) {
    const re = new RegExp(rule.re.source, rule.re.flags.replace('g', ''));
    if (re.test(latin) || re.test(utf16)) findings.push({ rule: rule.id, what: rule.what, line: 0, excerpt: '(binary)' });
  }
  return findings;
}

function excerpt(line, at) {
  const a = Math.max(0, at - 30);
  return (a ? '…' : '') + line.slice(a, at + 50).trim() + (at + 50 < line.length ? '…' : '');
}

const isBinary = (path, buf) => BINARY_EXT.has(extname(path).toLowerCase()) || buf.subarray(0, 8000).includes(0);

/** Vendored files that match the manifest byte for byte are third-party code. */
function vendorExceptions(root) {
  const p = join(root, 'vendor', 'manifest.json');
  const ok = new Map();
  if (!existsSync(p)) return ok;
  const manifest = JSON.parse(readFileSync(p, 'utf8'));
  for (const [pkg, entry] of Object.entries(manifest.packages || {})) {
    for (const [file, meta] of Object.entries({ ...entry.files, ...entry.licenses })) {
      ok.set(['vendor', pkg, file].join('/'), meta.sha256);
    }
  }
  return ok;
}

function listRepoFiles(root) {
  const out = execFileSync(GIT, ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return [...new Set(out.split('\0').filter(Boolean))].filter(f => existsSync(join(root, f)));
}

function listDir(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listDir(p, base));
    else if (e.isFile()) out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/** Sweep a list of files under `base`. */
export function sweepFiles(base, files, rules, { vendorOk = new Map(), label = '' } = {}) {
  const findings = [];
  let binaries = 0, texts = 0, vendored = 0;
  for (const f of files) {
    const buf = readFileSync(join(base, f));
    const sha = vendorOk.get(f);
    const third = sha && createHash('sha256').update(buf).digest('hex') === sha;
    if (third) vendored++;
    if (isBinary(f, buf) || third) {
      binaries += third ? 0 : 1;
      for (const x of sweepBinary(buf, rules)) findings.push({ file: label + f, ...x });
      continue;
    }
    texts++;
    for (const x of sweepText(buf.toString('utf8'), extname(f).toLowerCase(), rules)) findings.push({ file: label + f, ...x });
  }
  return { findings, counts: { texts, binaries, vendored } };
}

/** Git metadata: one identity, no co-author lines, and the text rules over messages. */
export function sweepGit(root, rules) {
  const findings = [];
  let ids = '';
  try { ids = execFileSync(GIT, ['-C', root, 'log', '--format=%an %ae %cn %ce'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return { findings, ids: [] }; }
  const set = [...new Set(ids.split('\n').filter(Boolean))];
  // The one identity allowed is the repo's local one, and it must be a noreply address.
  const cfg = k => { try { return execFileSync(GIT, ['-C', root, 'config', '--local', '--get', k], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const name = cfg('user.name'), email = cfg('user.email');
  if (!/@users\.noreply\.github\.com$/.test(email)) findings.push({ file: '(git config)', rule: 'identity', what: 'the local user.email is not a noreply address', line: 0, excerpt: email ? '<address>' : '(unset)' });
  const expected = `${name} ${email} ${name} ${email}`;
  for (const id of set) if (id !== expected) findings.push({ file: '(git log)', rule: 'identity', what: 'author or committer other than the local noreply identity', line: 0, excerpt: id.replace(/\S+@(?!users\.noreply\.github\.com)\S+/g, '<address>') });
  const bodies = execFileSync(GIT, ['-C', root, 'log', '--format=%H%n%B%n--end--'], { encoding: 'utf8' });
  for (const block of bodies.split('--end--\n')) {
    const [hash, ...msg] = block.split('\n');
    if (!hash) continue;
    for (const x of sweepText(msg.join('\n'), '.txt', rules)) findings.push({ file: '(commit ' + hash.slice(0, 12) + ')', ...x });
  }
  return { findings, ids: set };
}

/** Every rule must catch its bait and let its clean line pass. */
export function selfTest(rules) {
  const failures = [];
  for (const r of rules) {
    const caught = sweepText(r.bait, '.md', [r]).length > 0;
    const passed = sweepText(r.clean, '.md', [r]).length === 0;
    if (!caught) failures.push(`${r.id}: the bait was not caught`);
    if (!passed) failures.push(`${r.id}: the clean line was flagged`);
  }
  return failures;
}

function main(argv) {
  const args = new Set(argv);
  const release = args.has('--release');
  if (release && !process.env.ELFFUSS_SWEEP_PRIVATE) {
    console.error('sweep --release needs ELFFUSS_SWEEP_PRIVATE (a file outside the repo with the private terms)');
    return 1;
  }
  const rules = [...staticRules(), ...machineRules()];
  const failures = selfTest(rules);
  console.log(`self-test: ${rules.length} rules, ${failures.length} failures`);
  for (const f of failures) console.log('  ✗ ' + f);
  if (args.has('--self-test')) return failures.length ? 1 : 0;

  const all = [];
  const repoFiles = listRepoFiles(ROOT);
  const repo = sweepFiles(ROOT, repoFiles, rules, { vendorOk: vendorExceptions(ROOT) });
  console.log(`repo: ${repoFiles.length} files (${repo.counts.texts} text, ${repo.counts.binaries} binary, ${repo.counts.vendored} vendored and matching the manifest)`);
  all.push(...repo.findings);

  const distIdx = argv.indexOf('--dist');
  const dists = distIdx >= 0 ? [argv[distIdx + 1]] : (release && existsSync(join(ROOT, 'dist')) ? [join(ROOT, 'dist')] : []);
  for (const d of dists) {
    if (!d || !existsSync(d) || !statSync(d).isDirectory()) { console.error('--dist needs an existing directory'); return 1; }
    const files = listDir(d);
    const r = sweepFiles(d, files, rules, { label: 'dist:' });
    console.log(`dist: ${files.length} files (${r.counts.texts} text, ${r.counts.binaries} binary)`);
    all.push(...r.findings);
  }
  if (args.has('--git') || release) {
    const g = sweepGit(ROOT, rules);
    console.log(`git: identities ${JSON.stringify(g.ids)}`);
    all.push(...g.findings);
  }

  const byRule = new Map();
  for (const r of rules) byRule.set(r.id, 0);
  byRule.set('identity', 0);
  for (const f of all) byRule.set(f.rule, (byRule.get(f.rule) || 0) + 1);
  for (const f of all) console.log(`${f.file}:${f.line}: [${f.rule}] ${f.what}: ${f.excerpt}`);
  console.log('per rule: ' + [...byRule].map(([k, v]) => `${k}=${v}`).join(' '));
  console.log(all.length || failures.length ? `SWEEP FAILED: ${all.length} findings` : 'sweep: 0 findings');
  return all.length || failures.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
