// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The storyboard video on WebGPU, before its weights are hosted: the registry with the
// storyboard model (its new repository at a placeholder revision, from
// scripts/wan/make_hub_vace.py), files from the weight cache (tests/browser/video-gen-serve.mjs).
// ?case=a|b|c picks one of the three test requests; ?t2v=1 first makes today's 2 s video from a
// text on the same device, to measure the storyboard's cost against it. Results in window.__result.
import { TextToVideo, StoryVideo, planStory, checkPlan, readPhoto } from '../../../sdk/video-gen/index.js';
import { createStoryView } from '../../../apps/video/story-view.js';

const q = new URLSearchParams(location.search);
const $ = s => document.querySelector(s);
const log = (...a) => { const s = a.join(' '); console.log(s); $('[data-role="log"]').textContent += s + '\n'; };
const STRINGS = {
  'story.keyframe': 'Imagen clave {n} ({s} s)', 'story.clip': 'Clip {n}', 'story.play': 'Ver de {a} a {b} s', 'story.startPhoto': 'Tu foto inicial',
  'story.endPhoto': 'Tu foto final', 'story.repaint': 'Pintarla de nuevo', 'story.change': 'Cambiar', 'story.look': 'Así va la historia.',
  'story.continue': 'Seguir ({s})', 'story.continueNow': 'Seguir', 'story.changed': 'Cuando te guste, sigue.',
};
const t = (k, v = {}) => String(STRINGS[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');

const registry = await (await fetch(q.get('registry') || '../../../tmp/story-registry.json')).json();
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
const photo = async name => (await readPhoto(await (await fetch(`../../../tmp/inputs/${name}`)).blob())).picture;
const fox = 'a red fox with a white chest and black-tipped ears, in a misty pine forest at dawn, golden sunrise light through the trees, cinematic wildlife photography, photorealistic';
const CASES = {
  a: { size: '832x480', plan: { seed: 7, style: fox, shots: [
    { prompt: 'a red fox curled up asleep on the mossy forest floor, eyes closed, tail wrapped around its body' },
    { prompt: 'a red fox lying on the mossy forest floor waking up, head raised, eyes open, ears up', from: 0, t: 1.45 },
    { prompt: 'a red fox standing on the mossy forest floor stretching, front legs stretched forward, back arched, yawning', from: 1, t: 1.45 },
    { prompt: 'a red fox running fast across the forest floor, side view, legs extended mid-stride', from: 2, t: 1.45 }],
  clips: ['a sleeping red fox slowly wakes up, opens its eyes and lifts its head', 'the red fox gets up and stretches its front legs, arching its back and yawning', 'the red fox starts running and dashes off through the forest'] } },
  b: { size: '624x624', start: 'web-fox-2.png', plan: { seed: 11, style: 'a red fox sitting among autumn leaves in a forest, warm backlight, photorealistic', shots: [
    { image: 'start' },
    { prompt: 'snowflakes falling all around, a thin layer of snow beginning to cover the leaves, the fox sitting and looking to the side', from: 0, t: 1.3 },
    { prompt: 'snow falling, snow on the leaves, the fox facing the camera and looking straight at the viewer', from: 1, t: 1.45 }],
  clips: ['snow starts to fall gently around the sitting fox, snowflakes drifting down', 'snow keeps falling as the fox turns its head and looks straight at the camera'] } },
  c: { size: '624x624', start: 'web-astronaut.png', end: 'astronaut-end.png', plan: { seed: 5, style: 'a chubby cream-white toy astronaut figurine with a big round black glossy visor on a cracked cream-coloured egg-shaped moon rock, grey lunar dust, dark background, macro photography, photorealistic',
    shots: [{ image: 'start' }, { image: 'end' }], clips: ['the tiny astronaut climbs up onto the moon egg and raises both arms to wave'] } },
  template: { size: '832x480', plan: planStory({ prompt: q.get('prompt') || 'un zorro que despierta en el bosque al amanecer, se estira y sale corriendo', seconds: 9 }) },
};
const c = CASES[q.get('case') || 'a'];
const result = { case: q.get('case') || 'a', size: c.size };
const view = createStoryView($('[data-role="story"]'), { t, reduced: q.get('reduced') === '1', countdown: Number(q.get('countdown') || 3) });
try {
  const adapter = await navigator.gpu?.requestAdapter();
  result.adapter = { f16: adapter?.features.has('shader-f16'), maxBuffer: adapter?.limits.maxBufferSize };
  if (q.get('t2v') === '1') {
    const t0 = performance.now(); const stages = {};
    const t2v = new TextToVideo({ registry, store, onProgress: p => { if (p.stage && p.stage !== 'download') stages[p.stage] ??= performance.now() - t0; } });
    const r = await t2v.run(null, { prompt: 'a red fox running through the snow, cinematic', seconds: 2, size: '832x480', steps: 4, seed: 7 });
    await t2v.dispose();
    result.t2v = { ms: Math.round(performance.now() - t0), frames: r.frames, stages };
    log('t2v 2 s', JSON.stringify(result.t2v));
  }
  const given = { start: c.start ? await photo(c.start) : undefined, end: c.end ? await photo(c.end) : undefined };
  const plan = checkPlan(c.plan, { start: Boolean(given.start), end: Boolean(given.end) });
  view.setPlan(plan, { size: c.size });
  const marks = []; const mark = (what, extra = {}) => marks.push({ what, at: Math.round(performance.now() - T0), ...extra });
  const T0 = performance.now();
  const story = new StoryVideo({ registry, store, onProgress: p => {
    if (p.stage === 'keyframe') { view.keyframe(p.index, p); if (p.done) mark('keyframe', { k: p.index }); else if (p.preview) mark('keyframe-preview', { k: p.index }); }
    else if (p.stage === 'clip') { if (p.done) { view.clipDone(p.clip, p); mark('clip', { i: p.clip }); } else { view.clipStep(p.clip, p); mark('clip-step', { i: p.clip, s: p.index }); } }
    else if (p.stage && p.stage !== 'download') { $('[data-role="status"]').textContent = `${p.stage} ${(p.index ?? 0) + 1}/${p.count ?? 1}`; mark(p.stage, { s: p.index }); }
  } });
  const kf = await story.keyframes({ plan, size: c.size, ...given });
  result.keyframesMs = Math.round(performance.now() - T0);
  log('keyframes', result.keyframesMs, 'ms');
  const answer = await view.askContinue();
  result.answer = answer;
  const T1 = performance.now();
  const r = await story.clips({ plan, size: kf.size, keyframes: kf.keyframes, ...given });
  result.clipsMs = Math.round(performance.now() - T1);
  await story.dispose();
  result.video = { width: r.width, height: r.height, frames: r.frames, seconds: r.seconds, mime: r.mime, bytes: r.blob.size, clips: r.clips };
  result.marks = marks;
  const v = $('section.result video'); v.src = URL.createObjectURL(r.blob); $('section.result').hidden = false;
  window.__blob = r.blob;
  log('done', JSON.stringify({ ...result, marks: undefined }));
} catch (err) {
  result.error = { code: err?.code, message: err?.message, cause: String(err?.cause?.message || '') };
  log('error', JSON.stringify(result.error));
}
window.__result = result;
window.__done = true;
