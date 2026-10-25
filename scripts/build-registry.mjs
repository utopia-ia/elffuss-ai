#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Generates registry/tasks.json and sdk/<task>/sizes.js from registry/source.mjs
// and the Hugging Face API. Needs the network; the unit tests never run it.
//
//   node scripts/build-registry.mjs            check every pin live and write the files
//   node scripts/build-registry.mjs --check    regenerate in memory and compare (exit 1 on any difference)
//   node scripts/build-registry.mjs --resolve  rewrite the revisions of source.mjs to today's `main`
//
// It fails when a licence (of the model or of its base) is not in the allowed
// list, when a repo is private or gated, when a revision is not the commit the
// Hub returns, when a file is missing, when a repo or licence is on the deny
// list, or when a model-store key of a pinned URL would be cut (180 characters).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pinnedUrl, isCommit, isSafePath, PINNED_URL_RE, HUB_ORIGIN } from '../sdk/core/hub-url.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'registry', 'source.mjs');
const OUT = join(ROOT, 'registry', 'tasks.json');
const API = `${HUB_ORIGIN}/api/models/`;

export const ALLOWED_LICENSES = ['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause'];
export const DENY_REPOS = [/Depth-Anything-V2-(Base|Large|Giant)/i, /RMBG/i];
export const DENY_LICENSES = [/^cc-by-nc/i, /^openrail/i, /^lfm/i, /^gemma/i, /^llama/i, /^other$/i];
const SPDX = { 'apache-2.0': 'Apache-2.0', mit: 'MIT', 'bsd-2-clause': 'BSD-2-Clause', 'bsd-3-clause': 'BSD-3-Clause' };
export const normLicense = l => SPDX[String(l || '').toLowerCase()] || String(l || '');
const WEIGHT = /\.onnx(_data(_\d+)?)?$/;
export const MAX_KEY = 180;

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'elffuss-ai-registry', ...headers } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return { json: await r.json(), link: r.headers.get('link') };
}

async function tree(repo, revision) {
  const files = [];
  let url = `${API}${repo}/tree/${revision}?recursive=true`;
  while (url) {
    const { json, link } = await getJSON(url);
    for (const x of json) if (x.type === 'file') files.push(x);
    const next = /<([^>]+)>;\s*rel="next"/.exec(link || '');
    url = next ? next[1] : null;
  }
  return files;
}

function denied(repo, license) {
  return DENY_REPOS.some(re => re.test(repo)) || DENY_LICENSES.some(re => re.test(license));
}

async function baseLicense(base) {
  if (base.source.hf) {
    const { json } = await getJSON(`${API}${base.source.hf}`);
    if (json.private || json.gated) throw new Error(`${base.source.hf}: private or gated`);
    return { license: normLicense(json.cardData?.license), url: `${HUB_ORIGIN}/${base.source.hf}`, repo: base.source.hf };
  }
  if (base.source.github) {
    const { json } = await getJSON(`https://api.github.com/repos/${base.source.github}/license`);
    return { license: json.license?.spdx_id || '', url: `https://github.com/${base.source.github}`, repo: base.source.github };
  }
  throw new Error('base model needs a source');
}

/** Build the registry object from the source, reading the Hub. */
export async function generate(source) {
  const out = { schema: 1, tasks: source.tasks, models: {} };
  const problems = [];
  for (const [id, m] of Object.entries(source.models)) {
    if (!/^(remove-bg|depth|detect|ocr)\/[a-z0-9.-]+$/.test(id)) problems.push(`${id}: bad model id`);
    if (!id.startsWith(m.task + '/')) problems.push(`${id}: id does not start with its task`);
    const used = new Set();
    for (const variants of Object.values(m.devices)) for (const v of variants) for (const f of v.files) used.add(f);
    const parts = {};
    const licenses = new Set();
    for (const [partName, p] of Object.entries(m.parts)) {
      if (!isCommit(p.revision)) { problems.push(`${id}/${partName}: revision is not a 40-hex commit`); continue; }
      const { json: info } = await getJSON(`${API}${p.repo}/revision/${p.revision}`);
      if (info.sha !== p.revision) problems.push(`${id}/${partName}: the Hub returned ${info.sha} for ${p.revision}`);
      if (info.private) problems.push(`${p.repo}: private`);
      if (info.gated) problems.push(`${p.repo}: gated`);
      const license = normLicense(info.cardData?.license);
      licenses.add(license);
      if (!ALLOWED_LICENSES.includes(license)) problems.push(`${p.repo}: licence ${license || '(none)'} is not allowed`);
      if (denied(p.repo, license)) problems.push(`${p.repo}: on the deny list`);
      const files = {};
      const usedHere = [...used].filter(u => u.startsWith(partName + ':')).map(u => u.slice(partName.length + 1));
      for (const f of await tree(p.repo, p.revision)) {
        // Weights that no variant uses are left out; every other file of the tree stays,
        // so that a request for something the repo does not have can be answered 404.
        if (WEIGHT.test(f.path) && !usedHere.includes(f.path) && !usedHere.some(u => f.path.startsWith(u + '_data'))) continue;
        // Repo metadata such as .gitattributes cannot go through the model store (no
        // segment may start with a dot) and nothing loads it: it stays out.
        if (!isSafePath(f.path)) { if (usedHere.includes(f.path)) problems.push(`${p.repo}: unsafe path ${f.path}`); continue; }
        files[f.path] = f.lfs ? { size: f.lfs.size ?? f.size, sha256: f.lfs.oid } : { size: f.size, gitOid: f.oid };
        if (!(files[f.path].size > 0)) problems.push(`${p.repo}/${f.path}: empty file`);
      }
      // External data of a used weight belongs to the same variant.
      for (const ref of used) {
        const [pn, path] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
        if (pn !== partName) continue;
        if (!files[path]) problems.push(`${id}: ${ref} is not in ${p.repo}@${p.revision}`);
      }
      parts[partName] = { repo: p.repo, revision: p.revision, license, author: info.author, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) };
      for (const path of Object.keys(files)) {
        const url = pinnedUrl(p.repo, p.revision, path);
        if (!PINNED_URL_RE.test(url)) problems.push(`${url}: the model store would refuse it`);
        if (url.replace(/[^\w.\-]+/g, '_').length > MAX_KEY) problems.push(`${url}: its store key would be cut at ${MAX_KEY} characters`);
      }
    }
    const devices = {};
    for (const [dev, variants] of Object.entries(m.devices)) {
      devices[dev] = variants.map(v => {
        const files = [...v.files];
        for (const ref of v.files) {
          const pn = ref.slice(0, ref.indexOf(':')), path = ref.slice(ref.indexOf(':') + 1);
          for (const extra of Object.keys(parts[pn]?.files || {})) {
            if (extra.startsWith(path + '_data') && !files.includes(`${pn}:${extra}`)) files.push(`${pn}:${extra}`);
          }
        }
        const bytes = files.reduce((s, ref) => {
          const pn = ref.slice(0, ref.indexOf(':')), path = ref.slice(ref.indexOf(':') + 1);
          return s + (parts[pn]?.files[path]?.size || 0);
        }, 0);
        return { ...(v.when ? { when: v.when } : {}), dtype: v.dtype, files, bytes };
      });
    }
    const base = await baseLicense(m.base);
    if (!ALLOWED_LICENSES.includes(base.license)) problems.push(`${id}: base licence ${base.license || '(none)'} is not allowed`);
    if (denied(base.repo, base.license)) problems.push(`${id}: base on the deny list`);
    out.models[id] = {
      task: m.task,
      name: m.name,
      license: [...licenses].join(' AND '),
      author: Object.values(parts)[0]?.author,
      base: { name: m.base.name, author: m.base.author, url: base.url, license: base.license },
      flag: m.flag,
      redistributes: m.redistributes,
      runtime: m.runtime,
      pipeline: m.pipeline,
      parts,
      devices,
      notes: m.notes,
    };
  }
  for (const [task, t] of Object.entries(source.tasks)) {
    if (!out.models[t.default]) problems.push(`${task}: default model ${t.default} is not in the registry`);
    else if (out.models[t.default].task !== task) problems.push(`${task}: default model belongs to another task`);
  }
  return { registry: out, problems };
}

/** Text of sdk/<task>/sizes.js for one task. */
export function sizesSource(registry, task) {
  const models = Object.fromEntries(Object.entries(registry.models).filter(([, m]) => m.task === task).map(([id, m]) => [id,
    Object.fromEntries(Object.entries(m.devices).map(([dev, vs]) => [dev, vs.map(v => ({ ...(v.when ? { when: v.when } : {}), dtype: v.dtype, bytes: v.bytes }))]))]));
  return `// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// GENERATED by scripts/build-registry.mjs from registry/tasks.json. Do not edit.

/** Default model of this task. */
export const DEFAULT_MODEL = ${JSON.stringify(registry.tasks[task].default)};

/**
 * Download size in bytes of every variant of this task's models, by model id and
 * backend, in the registry's order of preference.
 */
export const SIZES = Object.freeze(${JSON.stringify(models, null, 2)});
`;
}

export function serialise(registry) {
  return JSON.stringify(registry, null, 2) + '\n';
}

async function resolveMain(sourceText, source) {
  let text = sourceText;
  for (const m of Object.values(source.models)) {
    for (const p of Object.values(m.parts)) {
      const { json } = await getJSON(`${API}${p.repo}/revision/main`);
      if (!isCommit(json.sha)) throw new Error(`${p.repo}: no commit for main`);
      if (json.sha !== p.revision) {
        const re = new RegExp(`(repo: '${p.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}', revision: ')[0-9a-f]{40}(')`);
        if (!re.test(text)) throw new Error(`cannot find the revision line of ${p.repo}`);
        text = text.replace(re, `$1${json.sha}$2`);
        console.log(`${p.repo}: ${p.revision} → ${json.sha}`);
      } else console.log(`${p.repo}: ${p.revision} is main`);
    }
  }
  return text;
}

async function main(argv) {
  const sourceText = readFileSync(SOURCE, 'utf8');
  const source = (await import(pathToFileURL(SOURCE).href + '?t=' + Date.now())).default;
  if (argv.includes('--resolve')) {
    const text = await resolveMain(sourceText, source);
    if (text !== sourceText) writeFileSync(SOURCE, text);
    return 0;
  }
  const { registry, problems } = await generate(source);
  for (const p of problems) console.log('✗ ' + p);
  if (problems.length) return 1;
  const files = new Map([[OUT, serialise(registry)]]);
  for (const task of Object.keys(registry.tasks)) files.set(join(ROOT, 'sdk', task, 'sizes.js'), sizesSource(registry, task));
  if (argv.includes('--check')) {
    let diff = 0;
    for (const [p, text] of files) {
      const now = existsSync(p) ? readFileSync(p, 'utf8') : null;
      if (now !== text) { console.log(`✗ ${p.slice(ROOT.length + 1)} differs from what the Hub gives today`); diff++; }
    }
    console.log(diff ? `registry: ${diff} files differ` : 'registry: committed files match the Hub');
    return diff ? 1 : 0;
  }
  for (const [p, text] of files) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
  const n = Object.values(registry.models).reduce((s, m) => s + Object.values(m.parts).reduce((t, p) => t + Object.keys(p.files).length, 0), 0);
  console.log(`registry: ${Object.keys(registry.models).length} models, ${n} files pinned`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error('✗ ' + (e.stack || e)); process.exitCode = 1; });
}
