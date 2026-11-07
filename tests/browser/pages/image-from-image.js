// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A picture made from another (SANA-Sprint, SDEdit) on WebGPU, before the image encoder is
// hosted: the registry with the text-to-image model's encoder at a placeholder revision (from
// scripts/text-to-image/stage_encoder.py), files from the weight cache
// (tests/browser/video-gen-serve.mjs). ?photo=<file in tmp/inputs>&prompts=a|b|c&strengths=0.4,0.6,0.8
// Each result's PNG in window.__results (base64), for a person to look at.
import { TextToImage } from '../../../sdk/text-to-image/index.js';

const q = new URLSearchParams(location.search);
const log = s => { console.log(s); document.querySelector('[data-role="log"]').textContent += s + '\n'; };
const registry = await (await fetch(q.get('registry') || '../../../tmp/image-registry.json')).json();
const local = url => url.replace(/^https:\/\/huggingface\.co\/(.+?)\/resolve\/([0-9a-f]{40})\//, '/hf/$1/$2/');
const store = {
  async has(url, bytes) { const r = await fetch(local(url), { method: 'HEAD' }); return r.ok && Number(r.headers.get('content-length')) === bytes; },
  async get(url, { bytes, onProgress }) {
    const r = await fetch(local(url));
    if (!r.ok) throw new Error('not in the weight cache: ' + url);
    const blob = await r.blob();
    onProgress?.({ loaded: blob.size, total: bytes });
    return blob;
  },
  cancel() {}, dispose() {},
};
const results = [];
try {
  const photo = await (await fetch(`../../../tmp/inputs/${q.get('photo') || 'web-fox-2.png'}`)).blob();
  const prompts = (q.get('prompts') || 'the same fox as a watercolour painting|the same fox in the snow, snow falling|the same fox at night under the moonlight').split('|');
  const strengths = (q.get('strengths') || '0.6').split(',').map(Number);
  const task = new TextToImage({ registry, store });
  for (const prompt of prompts) for (const strength of strengths) {
    const t0 = performance.now();
    const r = await task.generate({ prompt, image: photo, strength, seed: 7 });
    const b = new Uint8Array(await r.blob.arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    results.push({ prompt, strength, width: r.width, height: r.height, fromImage: r.fromImage, ms: Math.round(performance.now() - t0), png: btoa(s) });
    log(`${prompt} @ ${strength}: ${r.width} × ${r.height}, ${Math.round(performance.now() - t0)} ms`);
  }
  await task.dispose();
} catch (err) { results.push({ error: String(err?.message || err), cause: String(err?.cause?.message || '') }); log('error ' + err?.message); }
window.__results = results;
window.__done = true;
