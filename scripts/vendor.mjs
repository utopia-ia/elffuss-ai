#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Third-party runtimes, copied byte for byte into vendor/ and pinned in
// vendor/manifest.json. The sites serve them from their own origin; nothing is
// loaded from a CDN at run time.
//
//   node scripts/vendor.mjs --check            no network: every vendored file has the
//                                               size and sha256 of the manifest, nothing
//                                               extra, and sdk/core/runtime-pins.js matches
//   node scripts/vendor.mjs --fetch            network: download every pinned package by its
//                                               exact version, require the tarball's sha512 to
//                                               be the registry's and the manifest's, and every
//                                               file's sha256 to be the manifest's; then write
//   node scripts/vendor.mjs --pin <name@ver>   network: (re)pin one package at an exact
//                                               version and rewrite its manifest entry
//
// Licences that a package does not ship (onnxruntime-web has no LICENSE in npm)
// come from the upstream repository at the commit of the release tag, checked
// by their git blob hash. Licences of code a file bundles (Transformers.js
// carries @huggingface/jinja and @huggingface/tokenizers) come from those
// packages, checked by their tarball's sha512, or from their repository.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readTgz } from './lib/tar.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const MANIFEST = join(VENDOR, 'manifest.json');
const PINS_FILE = join(ROOT, 'sdk', 'core', 'runtime-pins.js');

// What is taken from each package. Changing this needs a --pin.
export const SPECS = {
  '@huggingface/transformers': {
    key: 'transformers',
    select: ['dist/transformers.web.min.js'],
    licenses: [
      { path: 'LICENSE', from: 'package' },
      // dist/transformers.web.min.js bundles its two Hugging Face dependencies, at the
      // versions that were current when 4.3.1 was built: their licences go with it.
      // @huggingface/jinja publishes no licence file in npm: it is the one of its
      // repository, at the commit that released 0.5.10.
      { path: 'bundled/@huggingface/jinja@0.5.10/LICENSE', from: 'github', repo: 'huggingface/huggingface.js', commit: '6fca37c92522e9142c219ddb049c4112cebe0cd1', file: 'LICENSE', bundled: '@huggingface/jinja@0.5.10', license: 'MIT' },
      { path: 'bundled/@huggingface/tokenizers@0.2.0/LICENSE', from: 'npm', package: '@huggingface/tokenizers', version: '0.2.0', file: 'LICENSE', bundled: '@huggingface/tokenizers@0.2.0', license: 'Apache-2.0' },
    ],
  },
  'onnxruntime-web': {
    key: 'onnxruntimeWeb',
    select: [
      'dist/ort.webgpu.bundle.min.mjs', 'dist/ort-wasm-simd-threaded.asyncify.mjs', 'dist/ort-wasm-simd-threaded.asyncify.wasm',
      'dist/ort.wasm.bundle.min.mjs', 'dist/ort-wasm-simd-threaded.mjs', 'dist/ort-wasm-simd-threaded.wasm',
    ],
    licenses: [
      { path: 'LICENSE.txt', from: 'github', repo: 'microsoft/onnxruntime', tag: 'v{version}', file: 'LICENSE' },
      { path: 'ThirdPartyNotices.txt', from: 'github', repo: 'microsoft/onnxruntime', tag: 'v{version}', file: 'ThirdPartyNotices.txt' },
    ],
  },
  'pdfjs-dist': {
    key: 'pdfjs',
    select: [
      'build/pdf.min.mjs', 'build/pdf.worker.min.mjs',
      'wasm/openjpeg.wasm', 'wasm/jbig2.wasm', 'wasm/qcms_bg.wasm',
      'cmaps/*.bcmap', 'standard_fonts/*.pfb', 'standard_fonts/*.ttf', 'iccs/*.icc',
    ],
    licenses: [
      { path: 'LICENSE', from: 'package' }, { path: 'cmaps/LICENSE', from: 'package' }, { path: 'iccs/LICENSE', from: 'package' },
      { path: 'standard_fonts/LICENSE_FOXIT', from: 'package' }, { path: 'standard_fonts/LICENSE_LIBERATION', from: 'package' },
      { path: 'wasm/LICENSE_JBIG2', from: 'package' }, { path: 'wasm/LICENSE_OPENJPEG', from: 'package' },
      { path: 'wasm/LICENSE_PDFJS_JBIG2', from: 'package' }, { path: 'wasm/LICENSE_PDFJS_OPENJPEG', from: 'package' },
      { path: 'wasm/LICENSE_PDFJS_QCMS', from: 'package' }, { path: 'wasm/LICENSE_QCMS', from: 'package' },
    ],
  },
};

export const sha256 = b => createHash('sha256').update(b).digest('hex');
export const sha512b64 = b => 'sha512-' + createHash('sha512').update(b).digest('base64');
export const gitOid = b => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
const globToRe = g => new RegExp('^' + g.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');

export function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

/** Text of sdk/core/runtime-pins.js for a manifest. */
export function pinsSource(manifest) {
  const pins = {};
  const dirs = {};
  for (const [id, e] of Object.entries(manifest.packages)) {
    const key = SPECS[e.name]?.key;
    if (!key) throw new Error('no key for ' + e.name);
    pins[key] = e.version;
    dirs[key] = id;
  }
  return `// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// GENERATED by scripts/vendor.mjs from vendor/manifest.json. Do not edit.
// The exact runtime versions the sites ship, checked at start-up (runtime-mismatch).

/** Exact versions of the vendored runtimes. */
export const PINS = Object.freeze(${JSON.stringify(pins, null, 2).replace(/\n/g, '\n')});

/** Directory of each runtime under /vendor/. */
export const VENDOR_DIRS = Object.freeze(${JSON.stringify(dirs, null, 2)});
`;
}

function listFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

/** Offline check. Returns a list of problems (empty when all is well). */
export function check(manifest = readManifest()) {
  const problems = [];
  const expected = new Set(['manifest.json']);
  for (const [id, e] of Object.entries(manifest.packages)) {
    if (id !== `${e.name}@${e.version}`) problems.push(`${id}: entry id does not match name@version`);
    if (!/^\d+\.\d+\.\d+$/.test(e.version)) problems.push(`${id}: version is not an exact release`);
    if (!/^sha512-[A-Za-z0-9+/=]{88}$/.test(e.integrity || '')) problems.push(`${id}: missing or malformed sha512 integrity`);
    for (const [path, meta] of Object.entries({ ...e.files, ...e.licenses })) {
      const rel = `${id}/${path}`;
      expected.add(rel);
      const p = join(VENDOR, rel);
      if (!existsSync(p)) { problems.push(`${rel}: missing`); continue; }
      const b = readFileSync(p);
      if (b.length !== meta.size) problems.push(`${rel}: size ${b.length}, manifest ${meta.size}`);
      if (sha256(b) !== meta.sha256) problems.push(`${rel}: sha256 differs from the manifest`);
      if (meta.gitOid && gitOid(b) !== meta.gitOid) problems.push(`${rel}: git blob hash differs from the manifest`);
    }
  }
  for (const f of listFiles(VENDOR)) {
    if (/(^|\/)\._/.test(f) || f.endsWith('.DS_Store')) continue;
    if (!expected.has(f)) problems.push(`${f}: in vendor/ but not in the manifest`);
  }
  const pins = existsSync(PINS_FILE) ? readFileSync(PINS_FILE, 'utf8') : '';
  if (pins !== pinsSource(manifest)) problems.push('sdk/core/runtime-pins.js does not match the manifest (run --pin or --fetch)');
  return problems;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'elffuss-ai-vendor' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function getBytes(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'elffuss-ai-vendor' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Commit of a release tag on GitHub (annotated tags are dereferenced). */
async function tagCommit(repo, tag) {
  const ref = await getJSON(`https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  let obj = ref.object;
  while (obj.type === 'tag') obj = (await getJSON(`https://api.github.com/repos/${repo}/git/tags/${obj.sha}`)).object;
  if (obj.type !== 'commit') throw new Error(`${repo}@${tag}: not a commit`);
  return obj.sha;
}

/** Download, verify and return the files of one package. Throws on any mismatch. */
async function materialise(name, version, pinned) {
  const spec = SPECS[name];
  if (!spec) throw new Error(`no spec for ${name}; add it to SPECS`);
  const meta = await getJSON(`https://registry.npmjs.org/${name.replace('/', '%2F')}/${version}`);
  if (meta.version !== version) throw new Error(`${name}: registry returned ${meta.version}`);
  const tarball = meta.dist.tarball;
  const tgz = await getBytes(tarball);
  const integrity = sha512b64(tgz);
  if (integrity !== meta.dist.integrity) throw new Error(`${name}@${version}: tarball sha512 differs from the registry's`);
  if (pinned && pinned.integrity !== integrity) throw new Error(`${name}@${version}: tarball sha512 differs from the manifest`);
  const files = readTgz(tgz);
  const inPkg = new Map([...files].filter(([p]) => p.startsWith('package/')).map(([p, b]) => [p.slice('package/'.length), b]));
  const out = { files: {}, licenses: {}, bytes: new Map() };
  for (const pattern of spec.select) {
    const re = globToRe(pattern);
    const hits = [...inPkg.keys()].filter(p => re.test(p)).sort();
    if (!hits.length) throw new Error(`${name}@${version}: nothing matches ${pattern}`);
    for (const p of hits) {
      const b = inPkg.get(p);
      out.files[p] = { size: b.length, sha256: sha256(b) };
      out.bytes.set(p, b);
    }
  }
  for (const lic of spec.licenses) {
    let b, entry;
    const extra = lic.bundled ? { bundled: lic.bundled, license: lic.license } : {};
    if (lic.from === 'package') {
      b = inPkg.get(lic.path);
      if (!b) throw new Error(`${name}@${version}: the package has no ${lic.path}`);
      entry = { from: 'package', size: b.length, sha256: sha256(b) };
    } else if (lic.from === 'npm') {
      // Another package's file, from its tarball, checked against the registry's sha512.
      const meta2 = await getJSON(`https://registry.npmjs.org/${lic.package.replace('/', '%2F')}/${lic.version}`);
      const tgz2 = await getBytes(meta2.dist.tarball);
      const integrity2 = sha512b64(tgz2);
      if (integrity2 !== meta2.dist.integrity) throw new Error(`${lic.package}@${lic.version}: tarball sha512 differs from the registry's`);
      if (pinned?.licenses?.[lic.path] && pinned.licenses[lic.path].integrity !== integrity2) throw new Error(`${lic.package}@${lic.version}: tarball sha512 differs from the manifest`);
      b = readTgz(tgz2).get('package/' + lic.file);
      if (!b) throw new Error(`${lic.package}@${lic.version}: the package has no ${lic.file}`);
      entry = { from: meta2.dist.tarball, integrity: integrity2, file: lic.file, size: b.length, sha256: sha256(b), ...extra };
    } else {
      const tag = lic.tag ? lic.tag.replace('{version}', version) : undefined;
      const commit = lic.commit || pinned?.licenses?.[lic.path]?.commit || await tagCommit(lic.repo, tag);
      const url = `https://raw.githubusercontent.com/${lic.repo}/${commit}/${lic.file}`;
      b = await getBytes(url);
      const oid = gitOid(b);
      if (!pinned) {
        const contents = await getJSON(`https://api.github.com/repos/${lic.repo}/contents/${lic.file}?ref=${commit}`);
        if (contents.sha !== oid) throw new Error(`${url}: git blob hash differs from the repository tree`);
      }
      entry = { from: url, ...(tag ? { tag } : {}), commit, size: b.length, gitOid: oid, sha256: sha256(b), ...extra };
    }
    out.licenses[lic.path] = entry;
    out.bytes.set(lic.path, b);
  }
  if (pinned) {
    for (const [p, m] of Object.entries({ ...pinned.files, ...pinned.licenses })) {
      const got = out.files[p] || out.licenses[p];
      if (!got) throw new Error(`${name}@${version}: ${p} is pinned but was not produced`);
      if (got.sha256 !== m.sha256 || got.size !== m.size) throw new Error(`${name}@${version}: ${p} differs from the manifest`);
    }
    for (const p of Object.keys({ ...out.files, ...out.licenses })) {
      if (!(p in pinned.files) && !(p in pinned.licenses)) throw new Error(`${name}@${version}: ${p} is produced but not pinned (re-pin)`);
    }
  }
  return {
    entry: { name, version, license: meta.license, tarball, integrity, files: out.files, licenses: out.licenses },
    bytes: out.bytes,
  };
}

function writePackage(id, bytes) {
  const tmp = join(VENDOR, `.${id.replace('/', '__')}.tmp`);
  rmSync(tmp, { recursive: true, force: true });
  for (const [p, b] of bytes) {
    const dst = join(tmp, p);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, b);
  }
  const final = join(VENDOR, id);
  rmSync(final, { recursive: true, force: true });
  mkdirSync(dirname(final), { recursive: true });
  renameSync(tmp, final);
}

function writeManifest(manifest) {
  const sorted = { schema: 1, packages: Object.fromEntries(Object.entries(manifest.packages).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');
  mkdirSync(dirname(PINS_FILE), { recursive: true });
  writeFileSync(PINS_FILE, pinsSource(sorted));
}

async function main(argv) {
  if (argv[0] === '--check') {
    const problems = check();
    for (const p of problems) console.log('✗ ' + p);
    const m = readManifest();
    const n = Object.values(m.packages).reduce((s, e) => s + Object.keys(e.files).length + Object.keys(e.licenses).length, 0);
    console.log(problems.length ? `vendor: ${problems.length} problems` : `vendor: ${Object.keys(m.packages).length} packages, ${n} files, all match the manifest`);
    return problems.length ? 1 : 0;
  }
  if (argv[0] === '--fetch') {
    const m = readManifest();
    for (const [id, e] of Object.entries(m.packages)) {
      const { bytes } = await materialise(e.name, e.version, e);
      writePackage(id, bytes);
      console.log(`✓ ${id}: tarball sha512 and ${bytes.size} files match the manifest`);
    }
    const problems = check(m);
    for (const p of problems) console.log('✗ ' + p);
    return problems.length ? 1 : 0;
  }
  if (argv[0] === '--pin' && argv[1]) {
    const at = argv[1].lastIndexOf('@');
    const name = argv[1].slice(0, at), version = argv[1].slice(at + 1);
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('pin an exact release, like name@1.2.3');
    const m = existsSync(MANIFEST) ? readManifest() : { schema: 1, packages: {} };
    for (const [id, e] of Object.entries(m.packages)) if (e.name === name) { delete m.packages[id]; rmSync(join(VENDOR, id), { recursive: true, force: true }); }
    const { entry, bytes } = await materialise(name, version, null);
    const id = `${name}@${version}`;
    writePackage(id, bytes);
    m.packages[id] = entry;
    writeManifest(m);
    console.log(`✓ pinned ${id}: ${Object.keys(entry.files).length} files, ${Object.keys(entry.licenses).length} licence files`);
    return 0;
  }
  console.error('usage: vendor.mjs --check | --fetch | --pin <name@version>');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error('✗ ' + (e.message || e)); process.exitCode = 1; });
}
