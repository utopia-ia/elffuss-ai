// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The storyboard video's pure parts: the plan (template and check), the sizes from a
// photo's shape and where it sits without cropping, VACE's control against diffusers
// (tests/fixtures/video-gen/control.json, from scripts/storyboard/control_fixture.py),
// the colour match, SANA's SDEdit schedule and start, and the estimate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planStory, checkPlan, splitActions, clipCount, clipFrames, videoFrames, sizeForAspect, containRect,
  STORY_SIZES, SDEDIT_TIME, CLIP_FRAMES, CARRY, MAX_CLIPS, PLAN_GUIDE,
} from '../../sdk/video-gen/story/plan.js';
import { foldMask, controlTokens, knownFrames, maskFrameIndex, CONTROL_VALUES } from '../../sdk/video-gen/story/control.js';
import { colorStats, colorTransform, applyTransform, matchClip, blendStats } from '../../sdk/video-gen/story/color.js';
import { grid } from '../../sdk/video-gen/latent.js';
import { sdeditTimes, timesteps, MAX_TIME } from '../../sdk/text-to-image/schedule.js';
import { generate } from '../../sdk/text-to-image/pipeline.js';
import { estimateStory, storyPeakBytes, STORY_MODEL } from '../../sdk/video-gen/story.js';
import { placePhoto } from '../../sdk/video-gen/story-impl.js';

const fx = JSON.parse(readFileSync(new URL('../fixtures/video-gen/control.json', import.meta.url), 'utf8'));

test('plan: clips every 3 s up to 9 s, frames with the hand-over, 145 frames for 9 s', () => {
  assert.deepEqual([1, 3, 3.5, 6, 9, 12, 30].map(clipCount), [1, 1, 2, 2, 3, 3, 3]);
  assert.equal(MAX_CLIPS, 3);
  assert.deepEqual(clipFrames(3), [CLIP_FRAMES, CLIP_FRAMES + CARRY - 1, CLIP_FRAMES + CARRY - 1]);
  assert.deepEqual(clipFrames(3, 0), [49, 49, 49]);
  assert.equal(videoFrames(3), 145, 'three clips: 9 s at 16 fps, plus the first frame');
  assert.equal(videoFrames(2), 97);
  assert.equal(videoFrames(3, 0), 145, 'without hand-over the clips share their keyframe');
  for (const n of clipFrames(3)) assert.equal((n - 1) % 4, 0, 'every clip is 1 + 4k frames');
  assert.throws(() => clipCount(0));
});

test('plan: the actions of a request, Spanish and English', () => {
  assert.deepEqual(splitActions('un zorro que despierta en el bosque al amanecer, se estira y sale corriendo'),
    ['un zorro que despierta en el bosque al amanecer', 'se estira', 'sale corriendo']);
  assert.deepEqual(splitActions('haz que nieve y que el zorro mire a cámara'), ['haz que nieve', 'el zorro mire a cámara']);
  assert.deepEqual(splitActions('a cat sleeps on a sofa, then it wakes up and jumps to the floor.'), ['a cat sleeps on a sofa', 'it wakes up', 'jumps to the floor']);
  assert.deepEqual(splitActions('pan y vino'), ['pan y vino'], 'an "y" inside a noun phrase is not a new action');
  assert.deepEqual(splitActions(''), []);
});

test('plan: the template spreads the actions, each keyframe from the one before', () => {
  const p = planStory({ prompt: 'un zorro que despierta en el bosque al amanecer, se estira y sale corriendo', seconds: 9, seed: 7 });
  assert.equal(p.shots.length, 4); assert.equal(p.clips.length, 3); assert.equal(p.seed, 7);
  assert.equal(p.shots[0].from, undefined, 'the first from the text alone');
  p.shots.slice(1).forEach((s, i) => { assert.equal(s.from, i); assert.equal(s.t, SDEDIT_TIME); });
  assert.match(p.shots[2].prompt, /se estira/); assert.match(p.shots[3].prompt, /sale corriendo/);
  assert.match(p.clips[2], /^un zorro .*sale corriendo$/, 'every clip keeps the subject and place');
  checkPlan(p);
  // one change over three clips: written in degrees, never left for the last keyframe only
  const s = planStory({ prompt: 'it starts snowing', seconds: 9, start: true, lang: 'en' });
  assert.deepEqual(s.shots.map(x => x.image || x.prompt), ['start', 'it starts snowing (beginning)', 'it starts snowing (halfway)', 'it starts snowing (completely)']);
  assert.match(planStory({ prompt: 'nieva', seconds: 6, lang: 'es' }).shots[1].prompt, /empezando/);
  // photos: first and last; two photos and no text still make a clip
  const two = planStory({ prompt: '', seconds: 3, start: true, end: true });
  assert.deepEqual(two.shots, [{ image: 'start' }, { image: 'end' }]);
  assert.ok(two.clips[0].length > 0);
  checkPlan(two, { start: true, end: true });
  assert.throws(() => planStory({ prompt: '', seconds: 3 }), /description or two photos/);
});

test('plan: a written plan is checked before anything runs', () => {
  const ok = { seed: 3, style: 'a fox', shots: [{ prompt: 'a' }, { prompt: 'b', from: 0, t: 1.45 }], clips: ['x'] };
  assert.deepEqual(checkPlan(ok).shots[1], { prompt: 'b', image: null, from: 0, t: 1.45 });
  const bad = [
    [{ ...ok, clips: [] }, /1 to 3 clips/],
    [{ ...ok, clips: ['a', 'b', 'c', 'd'], shots: Array(5).fill({ prompt: 'a' }) }, /1 to 3 clips/],
    [{ ...ok, shots: [{ prompt: 'a' }] }, /one keyframe more/],
    [{ ...ok, shots: [{ prompt: 'a' }, { prompt: 'b', from: 1 }] }, /later one/],
    [{ ...ok, shots: [{ prompt: 'a' }, { prompt: 'b', t: 2 }] }, /t must be/],
    [{ ...ok, shots: [{ image: 'start' }, { prompt: 'b' }] }, /start photo/],
    [{ ...ok, shots: [{ prompt: '' }, { prompt: 'b' }] }, /neither a photo/],
    [{ ...ok, seed: -1 }, /seed/],
  ];
  for (const [p, re] of bad) assert.throws(() => checkPlan(p), re);
  assert.throws(() => checkPlan(ok, { start: true }), /start photo/);
  assert.match(PLAN_GUIDE, /Spread big changes/);
});

test('sizes: the storyboard size from a photo\'s shape; a photo is never cropped', () => {
  assert.equal(sizeForAspect(1920, 1080), STORY_SIZES['16:9']);
  assert.equal(sizeForAspect(1080, 1920), STORY_SIZES['9:16']);
  assert.equal(sizeForAspect(1024, 1024), STORY_SIZES['1:1']);
  assert.equal(sizeForAspect(1100, 1000), STORY_SIZES['1:1']);
  assert.equal(sizeForAspect(2000, 1000), STORY_SIZES['16:9']);
  assert.deepEqual(containRect(1024, 1024, 832, 480), { x: 176, y: 0, w: 480, h: 480 });
  assert.deepEqual(containRect(1600, 900, 624, 624), { x: 0, y: 136, w: 624, h: 351 });
  for (const [w, h] of [[1024, 1024], [4000, 3000], [1080, 1920], [3000, 1000]]) {
    const [W, H] = sizeForAspect(w, h).split('x').map(Number);
    const r = containRect(w, h, W, H);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H, 'inside the frame');
    assert.ok(Math.abs(r.w / r.h - w / h) < 0.02, 'with the photo\'s own shape');
  }
});

test('placePhoto: the photo whole in its rectangle, the bands filled from its edges', () => {
  const w = 4, h = 2, rgba = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) rgba.set([10 * p, 100, 200, 255], p * 4);
  const out = placePhoto({ rgba, width: w, height: h }, 8, 8);
  assert.deepEqual(out.rect, { x: 0, y: 2, w: 8, h: 4 });
  assert.deepEqual([...out.rgba.subarray((2 * 8 + 0) * 4, (2 * 8 + 0) * 4 + 3)], [0, 100, 200], 'the photo inside');
  assert.equal(out.rgba[0 + 3], 255, 'the bands are opaque');
  assert.equal(out.rgba[1], 100, 'the band above takes the edge\'s colour');
});

test('control: the folded mask is the one diffusers makes (nearest-exact frames, 8 × 8 blocks)', () => {
  const { frames, width, height, rect } = fx;
  const masks = new Array(frames).fill(null);
  const m0 = new Uint8Array(width * height).fill(1);
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) m0[y * width + x] = 0;
  masks[0] = m0; masks[8] = new Uint8Array(width * height);
  const got = foldMask(masks, { frames, width, height });
  assert.deepEqual([...got], fx.mask);
  assert.deepEqual(maskFrameIndex(49).slice(0, 3), [1, 5, 9]);
  assert.equal(maskFrameIndex(49).at(-1), 47, 'the last latent frame reads frame 47, as diffusers does (it is still told to paint)');
});

test('control: tokens in the order the exported graph reads them', () => {
  const g = grid({ width: fx.width, height: fx.height, frames: fx.frames });
  const tok = controlTokens(Float32Array.from(fx.inactive), Float32Array.from(fx.reactive), Float32Array.from(fx.mask), g);
  assert.equal(tok.length, g.tokens * CONTROL_VALUES);
  assert.deepEqual([g.tokens, CONTROL_VALUES], fx.shape);
  assert.deepEqual([...tok], fx.tokens);
});

test('control: known frames as pixels for the encoder, grey elsewhere, with their masks', () => {
  const W = 16, H = 8, px = W * H, rgba = new Uint8ClampedArray(px * 4).fill(255);
  const { pixels, masks } = knownFrames([{ frame: 0, rgba, rect: { x: 0, y: 0, w: 8, h: 8 } }, { frame: 4, rgba }], { frames: 5, width: W, height: H });
  assert.equal(pixels.length, 5 * 3 * px);
  assert.equal(pixels[0], 1, 'a known pixel'); assert.equal(pixels[8], 0.5, 'outside the rectangle: grey');
  assert.equal(pixels[3 * px], 0.5, 'an unknown frame: grey');
  assert.equal(masks[1], null); assert.equal(masks[0][0], 0); assert.equal(masks[0][8], 1); assert.ok(masks[4].every(v => v === 0));
  assert.throws(() => knownFrames([{ frame: 5, rgba }], { frames: 5, width: W, height: H }), RangeError);
});

test('colour: a frame matched to itself does not change; a drifted one comes back', () => {
  const n = 64 * 64, a = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) a.set([(p * 7) % 200 + 20, (p * 13) % 180 + 30, (p * 3) % 150 + 40, 255], p * 4);
  const same = Uint8ClampedArray.from(a);
  applyTransform(same, colorTransform(colorStats(a), colorStats(a)));
  assert.ok(same.every((v, i) => Math.abs(v - a[i]) <= 1), 'identity');
  // more contrast and a warmer cast, as the few-step clips drift
  const drift = Uint8ClampedArray.from(a, (v, i) => (i % 4 === 3 ? 255 : (v - 128) * 1.2 + 128 + (i % 4 === 0 ? 12 : 0)));
  const fixed = Uint8ClampedArray.from(drift);
  matchClip([fixed], a, a);
  const err = x => { let s = 0; for (let i = 0; i < x.length; i += 4) for (let c = 0; c < 3; c++) s += Math.abs(x[i + c] - a[i + c]); return s / n / 3; };
  assert.ok(err(fixed) < err(drift) / 3, `matched: ${err(fixed).toFixed(2)} vs drifted ${err(drift).toFixed(2)}`);
  const s0 = colorStats(a), s1 = { mean: s0.mean.map(v => v + 10), std: s0.std.map(v => v * 2) };
  assert.deepEqual(blendStats(s0, s1, 0, 5), s0);
  assert.deepEqual(blendStats(s0, s1, 4, 5), s1);
});

test('SDEdit: the two-step schedule scaled to start at t; the picture noised there', async () => {
  const s = sdeditTimes(1.45);
  assert.equal(s.length, 3); assert.equal(s[2], 0);
  assert.ok(Math.abs(s[0] - 1.45) < 1e-6 && Math.abs(s[1] - 1.45 * 1.3 / MAX_TIME) < 1e-5);
  assert.deepEqual([...sdeditTimes(MAX_TIME)], [...timesteps(2)].map((v, i) => (i === 1 ? Math.fround(MAX_TIME * 1.3 / MAX_TIME) : v)));
  assert.throws(() => sdeditTimes(0)); assert.throws(() => sdeditTimes(2));
  // stand-in models: what the first step is given, from a start near 0, is the picture itself
  const n = 4 * 2 * 2;
  const init = Float32Array.from({ length: n }, (_, i) => (i % 5) - 2);
  const seen = [];
  const m = {
    encode: () => [1, 2], embed: () => new Float32Array(2 * 4), hidden: 4,
    runEncoder: async () => new Float32Array(2 * 4),
    runTransformer: async o => { seen.push(Float32Array.from(o.latents)); return new Float32Array(o.latents.length); },
    runDecoder: async (z, h, w) => ({ data: new Float32Array(3 * h * 32 * w * 32), height: h * 32, width: w * 32 }),
    config: { channels: 4, factor: 32, scaling: 1, guidance: 4.5, sigmaData: 0.5 },
  };
  const req = { prompt: 'x', seed: 1, steps: 2, width: 64, height: 64, genWidth: 64, genHeight: 64 };
  const x0s = [];
  await generate(m, { ...req, init: { latents: init, t: 0.05 } }, { onX0: x0 => { x0s.push(Float32Array.from(x0)); } });
  assert.equal(seen.length, 2, 'two steps'); assert.equal(x0s.length, 1, 'one preview, after the first step');
  const close = seen[0].every((v, i) => Math.abs(v - init[i]) < 0.15 * (1 + Math.abs(init[i])));
  assert.ok(close, `near t = 0 the model is given the picture (${[...seen[0].slice(0, 4)]} vs ${[...init.slice(0, 4)]})`);
  const far = []; m.runTransformer = async o => { far.push(Float32Array.from(o.latents)); return new Float32Array(o.latents.length); };
  await generate(m, { ...req, init: { latents: init, t: MAX_TIME } });
  assert.ok(far[0].some((v, i) => Math.abs(v - init[i]) > 0.3), 'at π/2 the picture is all noise');
  await assert.rejects(generate(m, { ...req, init: { latents: new Float32Array(3), t: 1 } }), /latents have 3 values/);
});

test('estimate: the storyboard model\'s download and memory, honest reasons', async () => {
  const mem = storyPeakBytes({ tokens: 20280, clips: 3 }, { ditBytes: 2.3e9, sanaBytes: 3.5e9, encoderShardBytes: 0.74e9, embedBytes: 0.6e9 });
  assert.ok(mem.peak >= mem.clips && mem.peak >= mem.keyframes);
  assert.ok(mem.clips > 2.3e9 + 3 * 45 * 2 * 512 * 1536 * 2, 'the weights and every prompt\'s keys and values');
  const registry = { schema: 1, tasks: {}, models: {} };
  const none = await estimateStory({ seconds: 9 }, { registry, gpu: null });
  assert.equal(none.fits, false); assert.equal(none.reason, 'no-webgpu-variant');
  assert.equal(STORY_MODEL, 'text-to-video/wan2.1-vace-1.3b-rcm');
});
