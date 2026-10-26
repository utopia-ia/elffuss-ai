// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The software 3D view of the depth site: the grid, the projection (near moves
// more than far when the view turns), the depth buffer (near hides far), the
// light, and the view's limits under drags and keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMesh, renderRelief, project, clampView, dragView, keyView, VIEW, LIMITS } from '../../apps/depth/relief.js';

/** A map of w×h with `fn(x, y)` as depth, and a photo whose red is x and blue is y. */
function scene(w, h, fn) {
  const depth = new Float32Array(w * h);
  const tex = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    depth[y * w + x] = fn(x, y);
    tex.data.set([Math.round(x * 255 / (w - 1)), 128, Math.round(y * 255 / (h - 1)), 255], (y * w + x) * 4);
  }
  return { map: { depth, width: w, height: h }, tex };
}
const target = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const px = (t, x, y) => [...t.data.subarray((y * t.width + x) * 4, (y * t.width + x) * 4 + 4)];

test('the grid spans the photo, long side 1, and samples the depth bilinearly', () => {
  const { map } = scene(201, 101, x => x / 200);
  const m = buildMesh(map, { cols: 41 });
  assert.equal(m.gw, 41);
  assert.equal(m.gh, 21);
  assert.ok(Math.abs(m.x[0] + 0.5) < 1e-6 && Math.abs(m.x[m.gw - 1] - 0.5) < 1e-6, 'x from -0.5 to 0.5');
  assert.ok(Math.abs(m.y[0] - 101 / 201 / 2) < 1e-6, 'y up, half the short side');
  assert.ok(Math.abs(m.d[20] - 0.5) < 1e-6, 'depth in the middle');
  assert.ok(Math.abs(m.gx[20] - 1) < 1e-4, `slope along x per unit of the photo (${m.gx[20]})`);
  assert.ok(Math.abs(m.gy[20]) < 1e-6, 'no slope along y');
  assert.throws(() => buildMesh({ depth: new Float32Array(3), width: 2, height: 2 }), RangeError);
});

test('seen from the front with no relief, the photo fills the middle at its own colours', () => {
  const { map, tex } = scene(64, 48, () => 0.5);
  const m = buildMesh(map, { cols: 32 });
  const t = target(200, 150);
  const bg = [1, 2, 3];
  const { drawn } = renderRelief(m, tex, t, { yaw: 0, pitch: 0, relief: 0, background: bg });
  const want = Math.round(200 * 0.82) * Math.round(150 * 0.82);
  assert.ok(Math.abs(drawn - want) / want < 0.03, `covers the fitted rectangle (${drawn} vs ${want})`);
  assert.deepEqual(px(t, 0, 0), [...bg, 255], 'the corner is background');
  const c = px(t, 100, 75);
  const centre = [...tex.data.subarray((24 * 64 + 32) * 4, (24 * 64 + 32) * 4 + 4)];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(c[i] - centre[i]) <= 6, `centre keeps the photo's colour (${c} vs ${centre})`);
});

test('turning the view moves near points more than far ones, and the right way', () => {
  const { map } = scene(32, 32, () => 0.5);
  const m = buildMesh(map, { cols: 16 });
  const t = { width: 400, height: 400 };
  const near = { x: 0, y: 0, z: 0.2 }, far = { x: 0, y: 0, z: -0.2 };
  const front = project(near, { yaw: 0, pitch: 0 }, t, m);
  assert.ok(Math.abs(front.x - 200) < 1e-6 && Math.abs(front.y - 200) < 1e-6, 'the centre stays in the centre');
  const n = project(near, { yaw: 0.3, pitch: 0 }, t, m), f = project(far, { yaw: 0.3, pitch: 0 }, t, m);
  assert.ok(n.x > 200 && f.x < 200, 'a positive yaw takes the near point right and the far one left');
  assert.ok(n.dist < f.dist, 'the near point is nearer the eye');
  const down = project(near, { yaw: 0, pitch: 0.3 }, t, m);
  assert.ok(down.y > 200, 'a positive pitch takes the near point down');
});

test('the depth buffer: a near square hides what is behind it', () => {
  const w = 60, h = 60;
  const { map, tex } = scene(w, h, (x, y) => (x >= 20 && x < 40 && y >= 20 && y < 40 ? 1 : 0));
  const m = buildMesh(map, { cols: 60 });
  const t = target(300, 300);
  renderRelief(m, tex, t, { yaw: 0.5, pitch: 0, relief: 0.6, background: [0, 0, 0] });
  // Where the near square's centre lands, its own pixel shows (red of x≈30), not the far plane behind.
  const p = project({ x: 0, y: 0, z: 0.3 }, { yaw: 0.5, pitch: 0 }, t, m);
  const c = px(t, Math.round(p.x), Math.round(p.y));
  assert.ok(Math.abs(c[0] - Math.round(30 * 255 / 59)) <= 20, `the near square is in front (${c})`);
  // The same screen point without relief shows another part of the photo.
  const flat = target(300, 300);
  renderRelief(m, tex, flat, { yaw: 0.5, pitch: 0, relief: 0, background: [0, 0, 0] });
  const c2 = px(flat, Math.round(p.x), Math.round(p.y));
  assert.ok(Math.abs(c2[0] - c[0]) > 30, `without relief that pixel shows something else (${c2} vs ${c})`);
});

test('the light: a slope facing away from the light is darker than the flat photo', () => {
  const w = 40, h = 40;
  // Depth falls to the right: the surface faces right, away from a light on the upper left.
  const { map } = scene(w, h, x => 1 - x / (w - 1));
  const tex = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(200) };
  const m = buildMesh(map, { cols: 40 });
  const lit = target(200, 200), flat = target(200, 200);
  renderRelief(m, tex, lit, { yaw: 0, pitch: 0, relief: 0.8 });
  renderRelief(m, tex, flat, { yaw: 0, pitch: 0, relief: 0 });
  assert.ok(px(lit, 100, 100)[0] < px(flat, 100, 100)[0] - 5, `${px(lit, 100, 100)} vs ${px(flat, 100, 100)}`);
  assert.equal(px(flat, 100, 100)[0], 200, 'a flat face looking at the viewer keeps the photo\'s brightness');
});

test('the view stays inside its limits under drags and keys; Home goes back to the first view', () => {
  const v = clampView({ yaw: 5, pitch: -5, relief: 9 });
  assert.deepEqual(v, { yaw: LIMITS.yaw, pitch: -LIMITS.pitch, relief: LIMITS.reliefMax });
  const d = dragView({ ...VIEW }, 100, -50, 400);
  assert.ok(d.yaw > VIEW.yaw && d.pitch < VIEW.pitch, 'dragging right and up');
  assert.ok(keyView(VIEW, 'ArrowRight').yaw > VIEW.yaw);
  assert.ok(keyView(VIEW, 'ArrowLeft').yaw < VIEW.yaw);
  assert.ok(keyView(VIEW, 'ArrowDown').pitch > VIEW.pitch);
  assert.ok(keyView(VIEW, 'ArrowUp').pitch < VIEW.pitch);
  assert.deepEqual(keyView({ yaw: 0.5, pitch: 0.5, relief: 0.1 }, 'Home'), { yaw: VIEW.yaw, pitch: VIEW.pitch, relief: 0.1 });
  assert.equal(keyView(VIEW, 'a'), null);
  let w = { ...VIEW };
  for (let i = 0; i < 100; i++) w = keyView(w, 'ArrowRight');
  assert.equal(w.yaw, LIMITS.yaw);
});
