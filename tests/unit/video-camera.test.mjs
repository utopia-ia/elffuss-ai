// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The camera of the video task: every move starts from the photo as it is (or
// loops back to where it started), keeps the subject where it was, eases in and
// out, and is framed so that no edge of any layer ever shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, LOOPS, ASPECTS, planCamera, cameraAt, projectPoint, easeInOut, easeSmoother, frameCount, frameTime, baseWindow, coverZoom } from '../../sdk/video/camera.js';

const edge = (far, near) => [[...Array(41)].flatMap((_, i) => [{ u: i / 40, v: 0, d: far }, { u: i / 40, v: 1, d: near }, { u: 0, v: i / 40, d: far }, { u: 1, v: i / 40, d: far }])];

test('easing: still at both ends, monotonic', () => {
  for (const e of [easeInOut, easeSmoother]) {
    assert.equal(e(0), 0); assert.equal(e(1), 1);
    let last = -1;
    for (let i = 0; i <= 100; i++) { const v = e(i / 100); assert.ok(v >= last); last = v; }
    assert.ok(e(0.01) < 0.002 && e(0.99) > 0.998, 'slow at the ends');
  }
});

test('the first view shows the photo as it is: every point on its own ray, whatever its depth', () => {
  const plan = planCamera({ preset: 'dolly-in', aspect: 1.5, A: 1.5, focus: { u: 0.5, v: 0.5, d: 0.6 } });
  const v0 = cameraAt(plan, 0);
  for (const [u, v] of [[0.1, 0.2], [0.5, 0.5], [0.9, 0.8]]) {
    const a = projectPoint(plan, v0, u, v, 0), b = projectPoint(plan, v0, u, v, 1);
    assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, 'near and far coincide at the start');
  }
});

test('every move but the pan keeps the subject where it was in the frame', () => {
  for (const preset of PRESETS.filter(p => p !== 'zoom-pan')) {
    const plan = planCamera({ preset, aspect: 9 / 16, A: 1.5, focus: { u: 0.62, v: 0.4, d: 0.8 }, borders: edge(0.1, 0.9) });
    const f0 = projectPoint(plan, cameraAt(plan, 0), 0.62, 0.4, 0.8);
    for (const t of [0.25, 0.5, 0.75, 1]) {
      const f = projectPoint(plan, cameraAt(plan, t), 0.62, 0.4, 0.8);
      assert.ok(Math.hypot(f.x - f0.x, f.y - f0.y) < 1e-6, `${preset} at ${t}`);
    }
  }
});

test('a move shows parallax: near and far points part', () => {
  for (const preset of PRESETS) {
    const plan = planCamera({ preset, aspect: 16 / 9, A: 1.5, focus: { u: 0.5, v: 0.5, d: 0.6 } });
    const part = t => { const v = cameraAt(plan, t); const a = projectPoint(plan, v, 0.3, 0.3, 0), b = projectPoint(plan, v, 0.3, 0.3, 1); return Math.hypot(a.x - b.x, a.y - b.y); };
    const most = Math.max(part(0.2), part(0.5), part(1));
    assert.ok(most > 0.01, `${preset}: ${most}`);
  }
});

test('loops end where they start; one-way moves do not', () => {
  for (const preset of PRESETS) {
    const plan = planCamera({ preset, aspect: 1, A: 1.5, focus: { u: 0.5, v: 0.5, d: 0.5 } });
    const a = cameraAt(plan, 0), b = cameraAt(plan, 1);
    const same = JSON.stringify(a.pos.map(x => +x.toFixed(9))) === JSON.stringify(b.pos.map(x => +x.toFixed(9)));
    assert.equal(same, LOOPS.includes(preset), preset);
  }
  assert.equal(frameTime(0, 180, true), 0);
  assert.ok(frameTime(179, 180, true) < 1, 'a loop never repeats its first frame');
  assert.equal(frameTime(179, 180, false), 1);
  assert.equal(frameCount(6, 30), 180);
});

test('the framing keeps every layer edge out of the frame for the whole move', () => {
  for (const preset of PRESETS) {
    for (const aspect of Object.values(ASPECTS)) {
      const borders = edge(0.05, 0.95);
      const plan = planCamera({ preset, aspect, A: 1.5, focus: { u: 0.7, v: 0.6, d: 0.85 }, borders, strength: 1.5 });
      for (let i = 0; i <= 60; i++) {
        const view = cameraAt(plan, i / 60);
        for (const p of borders[0]) {
          const q = projectPoint(plan, view, p.u, p.v, p.d);
          assert.ok(Math.max(Math.abs(q.x), Math.abs(q.y)) >= 1 - 1e-6, `${preset} ${aspect.toFixed(2)} t=${i / 60}: edge point inside (${q.x.toFixed(3)}, ${q.y.toFixed(3)})`);
        }
      }
      assert.ok(coverZoom(plan, borders) <= plan.cover + 1e-9 || plan.cover >= 1);
    }
  }
});

test('the window has the output aspect, lies inside the photo and follows the subject', () => {
  const w = baseWindow(1.5, 9 / 16, { u: 0.9, v: 0.5 });
  assert.ok(Math.abs(w.hx / w.hy - 9 / 16) < 1e-9);
  assert.ok(w.cx + w.hx <= 0.75 + 1e-9 && w.cx > 0.3, 'pushed right, towards the subject, but inside');
  assert.throws(() => planCamera({ preset: 'spin', A: 1, focus: {} }), RangeError);
});
