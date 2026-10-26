// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The 3D view of a depth map, drawn in software: the photo is laid on a grid
// whose height follows the depth (nearer comes towards the viewer), turned by
// yaw and pitch, seen in perspective, lit from the upper left and painted with
// a depth buffer into an RGBA buffer. Pure functions over typed arrays: no
// canvas and no WebGL, so it draws the same in every browser, with or without
// WebGPU, and the tests run it in Node.

/** The view a result opens with: angles in radians, relief as a share of the long side. */
export const VIEW = Object.freeze({ yaw: -0.35, pitch: 0.22, relief: 0.35 });
/** How far the view may turn, and the range of the relief. */
export const LIMITS = Object.freeze({ yaw: 0.9, pitch: 0.7, reliefMin: 0, reliefMax: 0.8 });

const CAMERA = 2.4; // distance from the eye to the centre, in units of the long side
const FIT = 0.82; // share of the target the flat photo fills when seen from the front
const LIGHT = (() => { const l = [-0.35, 0.45, 0.82]; const n = Math.hypot(...l); return l.map(c => c / n); })();
const AMBIENT = 0.62, DIFFUSE = 0.38;
const FLAT = AMBIENT + DIFFUSE * LIGHT[2]; // shade of a face looking at the viewer: drawn at the photo's own brightness

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** The depth at a point between pixels, bilinear. */
function sample(depth, width, height, px, py) {
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = px - x0, fy = py - y0;
  const a = depth[y0 * width + x0], b = depth[y0 * width + x1], c = depth[y1 * width + x0], d = depth[y1 * width + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * The grid of a depth map: vertices across the long side (`cols`), each with
 * its place on the flat photo (`x` right, `y` up, centred, the long side 1
 * long), its depth, its pixel in the photo, and the slope of the depth there.
 * @param {{ depth: ArrayLike<number>, width: number, height: number }} map
 * @param {{ cols?: number }} [opts]
 */
export function buildMesh({ depth, width, height }, { cols = 160 } = {}) {
  if (!(width >= 2 && height >= 2) || depth.length !== width * height) throw new RangeError('the depth map does not have width × height values');
  const long = Math.max(width, height);
  const gw = clamp(Math.round(cols * width / long), 2, width);
  const gh = clamp(Math.round(cols * height / long), 2, height);
  const sx = width / long, sy = height / long;
  const n = gw * gh;
  const x = new Float32Array(n), y = new Float32Array(n), d = new Float32Array(n), u = new Float32Array(n), v = new Float32Array(n);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const px = i / (gw - 1) * (width - 1), py = j / (gh - 1) * (height - 1);
      x[k] = (i / (gw - 1) - 0.5) * sx;
      y[k] = (0.5 - j / (gh - 1)) * sy;
      d[k] = sample(depth, width, height, px, py);
      u[k] = px; v[k] = py;
    }
  }
  // Slope of the depth along x and y (per unit of the flat photo), for the light.
  const gx = new Float32Array(n), gy = new Float32Array(n);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const l = j * gw + Math.max(0, i - 1), r = j * gw + Math.min(gw - 1, i + 1);
      const t = Math.max(0, j - 1) * gw + i, b = Math.min(gh - 1, j + 1) * gw + i;
      gx[k] = (d[r] - d[l]) / (x[r] - x[l]);
      gy[k] = (d[t] - d[b]) / (y[t] - y[b]);
    }
  }
  return { gw, gh, sx, sy, x, y, d, u, v, gx, gy, width, height };
}

/** A view inside the limits. */
export function clampView({ yaw = VIEW.yaw, pitch = VIEW.pitch, relief = VIEW.relief } = {}) {
  return {
    yaw: clamp(Number(yaw) || 0, -LIMITS.yaw, LIMITS.yaw),
    pitch: clamp(Number(pitch) || 0, -LIMITS.pitch, LIMITS.pitch),
    relief: clamp(Number.isFinite(Number(relief)) ? Number(relief) : VIEW.relief, LIMITS.reliefMin, LIMITS.reliefMax),
  };
}

/** The view after dragging by (dx, dy) pixels on a view `size` pixels wide: the photo follows the pointer. */
export function dragView(view, dx, dy, size) {
  const k = Math.PI / Math.max(1, size);
  return clampView({ ...view, yaw: view.yaw + dx * k, pitch: view.pitch + dy * k });
}

/** The view after a key, or null when the key does not turn it. */
export function keyView(view, key) {
  const step = 0.08;
  if (key === 'ArrowLeft') return clampView({ ...view, yaw: view.yaw - step });
  if (key === 'ArrowRight') return clampView({ ...view, yaw: view.yaw + step });
  if (key === 'ArrowUp') return clampView({ ...view, pitch: view.pitch - step });
  if (key === 'ArrowDown') return clampView({ ...view, pitch: view.pitch + step });
  if (key === 'Home') return clampView({ ...VIEW, relief: view.relief });
  return null;
}

/**
 * Where a point of the flat photo lands on the target, and how far it is from
 * the eye. `z` is its height towards the viewer.
 * @returns {{ x: number, y: number, dist: number }}
 */
export function project(point, view, target, mesh) {
  const { yaw, pitch } = view;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const f = Math.min(target.width / mesh.sx, target.height / mesh.sy) * CAMERA * FIT;
  // Turn about the vertical axis (yaw), then about the horizontal one (pitch).
  const x1 = point.x * cy + point.z * sy, z1 = -point.x * sy + point.z * cy;
  const y2 = point.y * cp - z1 * sp, z2 = point.y * sp + z1 * cp;
  const dist = CAMERA - z2;
  return { x: target.width / 2 + f * x1 / dist, y: target.height / 2 - f * y2 / dist, dist };
}

/**
 * Paint the photo in relief into `target`.
 * @param {ReturnType<typeof buildMesh>} mesh
 * @param {{ width: number, height: number, data: ArrayLike<number> }} texture RGBA photo at the map's size
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} target RGBA pixels (an ImageData)
 * @param {{ yaw?: number, pitch?: number, relief?: number, background?: ArrayLike<number>, zbuffer?: Float32Array }} [opts]
 *   `background` is `[r, g, b, a]` for the pixels the photo does not cover; transparent by default,
 *   so the page shows through
 * @returns {{ drawn: number }} how many pixels show the photo
 */
export function renderRelief(mesh, texture, target, opts = {}) {
  const view = clampView(opts);
  const bg = opts.background || [0, 0, 0, 0];
  const bgAlpha = bg.length > 3 ? bg[3] : 255;
  const W = target.width, H = target.height, out = target.data;
  for (let i = 0; i < W * H * 4; i += 4) { out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; out[i + 3] = bgAlpha; }
  const zb = opts.zbuffer && opts.zbuffer.length >= W * H ? opts.zbuffer : new Float32Array(W * H);
  zb.fill(Infinity, 0, W * H);
  if (texture.width !== mesh.width || texture.height !== mesh.height) throw new RangeError('the photo and the depth map differ in size');

  const n = mesh.gw * mesh.gh;
  const X = new Float32Array(n), Y = new Float32Array(n), Z = new Float32Array(n), S = new Float32Array(n);
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  const f = Math.min(W / mesh.sx, H / mesh.sy) * CAMERA * FIT;
  const relief = view.relief;
  for (let k = 0; k < n; k++) {
    const z = (mesh.d[k] - 0.5) * relief;
    const x1 = mesh.x[k] * cy + z * sy, z1 = -mesh.x[k] * sy + z * cy;
    const y2 = mesh.y[k] * cp - z1 * sp, z2 = mesh.y[k] * sp + z1 * cp;
    const dist = CAMERA - z2;
    X[k] = W / 2 + f * x1 / dist;
    Y[k] = H / 2 - f * y2 / dist;
    Z[k] = dist;
    // The normal of the surface turns with it.
    const nx = -relief * mesh.gx[k], ny = -relief * mesh.gy[k];
    const nx1 = nx * cy + sy, nz1 = -nx * sy + cy;
    const ny2 = ny * cp - nz1 * sp, nz2 = ny * sp + nz1 * cp;
    const lambert = Math.max(0, (nx1 * LIGHT[0] + ny2 * LIGHT[1] + nz2 * LIGHT[2]) / Math.hypot(nx1, ny2, nz2));
    S[k] = (AMBIENT + DIFFUSE * lambert) / FLAT;
  }

  const tw = texture.width, th = texture.height, tex = texture.data;
  const tri = (a, b, c) => {
    const x0 = X[a], y0 = Y[a], x1 = X[b], y1 = Y[b], x2 = X[c], y2 = Y[c];
    const area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (!area) return;
    const inv = 1 / area;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    if (minX > maxX || minY > maxY) return;
    // Barycentric weights as edge functions, stepped along x.
    const a0 = (y1 - y2) * inv, a1 = (y2 - y0) * inv, a2 = (y0 - y1) * inv;
    const z0 = Z[a], z1 = Z[b], z2 = Z[c];
    const u0 = mesh.u[a], u1 = mesh.u[b], u2 = mesh.u[c];
    const v0 = mesh.v[a], v1 = mesh.v[b], v2 = mesh.v[c];
    const s0 = S[a], s1 = S[b], s2 = S[c];
    for (let py = minY; py <= maxY; py++) {
      const cyp = py + 0.5;
      let w0 = ((x2 - x1) * (cyp - y1) - (y2 - y1) * (minX + 0.5 - x1)) * inv;
      let w1 = ((x0 - x2) * (cyp - y2) - (y0 - y2) * (minX + 0.5 - x2)) * inv;
      let w2 = ((x1 - x0) * (cyp - y0) - (y1 - y0) * (minX + 0.5 - x0)) * inv;
      for (let px = minX; px <= maxX; px++, w0 += a0, w1 += a1, w2 += a2) {
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const o = py * W + px;
        const z = w0 * z0 + w1 * z1 + w2 * z2;
        if (z >= zb[o]) continue;
        zb[o] = z;
        const tx = clamp(Math.round(w0 * u0 + w1 * u1 + w2 * u2), 0, tw - 1);
        const ty = clamp(Math.round(w0 * v0 + w1 * v1 + w2 * v2), 0, th - 1);
        const s = w0 * s0 + w1 * s1 + w2 * s2;
        const t = (ty * tw + tx) * 4, q = o * 4;
        out[q] = Math.min(255, tex[t] * s); out[q + 1] = Math.min(255, tex[t + 1] * s); out[q + 2] = Math.min(255, tex[t + 2] * s); out[q + 3] = 255;
      }
    }
  };
  const gw = mesh.gw;
  for (let j = 0; j < mesh.gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const p = j * gw + i;
      tri(p, p + 1, p + gw + 1);
      tri(p, p + gw + 1, p + gw);
    }
  }
  let drawn = 0;
  for (let i = 0; i < W * H; i++) if (zb[i] !== Infinity) drawn++;
  return { drawn };
}
