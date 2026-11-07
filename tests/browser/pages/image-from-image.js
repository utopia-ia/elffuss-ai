// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A picture made from another (SANA-Sprint, SDEdit) on WebGPU, before the image encoder is
// hosted: the registry with the text-to-image model's encoder at a placeholder revision (from
// scripts/text-to-image/stage_encoder.py), files from the weight cache
// (tests/browser/video-gen-serve.mjs). ?photo=<file in tmp/inputs>&prompts=a|b|c&strengths=0.4,0.6,0.8
// Each result's PNG in window.__results (base64), for a person to look at.
import { TextToImage } from '../../../sdk/text-to-image/index.js';
import { composePrompt } from '../../../sdk/text-to-image/compose.js';
import { ImageToText } from '../../../sdk/image-to-text/index.js';

const q = new URLSearchParams(location.search);
const log = s => { console.log(s); document.querySelector('[data-role="log"]').textContent += s + '\n'; };
const registry = await (await fetch(q.get('registry') || '../../../registry/tasks.json')).json();
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
const png = async blob => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
if (q.get('sweep') === '1') {
  try {
    const task = new TextToImage({ registry, store });
    const eyes = new ImageToText({ registry, store });
    const person = (await task.generate({ prompt: 'a portrait photo of a young woman with curly dark hair and a yellow raincoat standing in a city park, natural light, photorealistic', seed: 3, aspect: '3:4' })).blob;
    const photos = [['fox', await (await fetch('../../../tmp/inputs/web-fox-2.png')).blob()], ['astronaut', await (await fetch('../../../tmp/inputs/web-astronaut.png')).blob()],
      ['street', await (await fetch('../../../tmp/inputs/web-street.png')).blob()], ['person', person]];
    const changes = ['en acuarela', 'de noche', 'nevando', 'estilo cómic'];
    const strengths = (q.get('strengths') || '0.5,0.6').split(',').map(Number);
    for (const [name, photo] of photos) {
      const { caption } = await eyes.run(photo, { want: 'caption' });
      results.push({ photo: name, caption, png: await png(photo) });
      log(`${name}: ${caption}`);
      for (const change of changes) {
        const { prompt } = composePrompt(caption, change);
        for (const strength of strengths) {
          const r = await task.generate({ prompt, image: photo, strength, seed: 7 });
          results.push({ photo: name, change, strength, prompt, composed: true, png: await png(r.blob) });
        }
      }
      const plain = await task.generate({ prompt: 'en acuarela', image: photo, strength: 0.6, seed: 7 });
      results.push({ photo: name, change: 'en acuarela', strength: 0.6, prompt: 'en acuarela', composed: false, png: await png(plain.blob) });
    }
    await eyes.dispose(); await task.dispose();
  } catch (err) { results.push({ error: String(err?.message || err), cause: String(err?.cause?.message || '') }); log('error ' + err?.message); }
  window.__results = results;
  window.__done = true;
  throw new Error('sweep done'); // nothing else to run
}
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
