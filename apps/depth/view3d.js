// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The interactive 3D view on a canvas: drag it with the pointer (or a finger)
// or use the arrow keys to turn it, Home to go back to the first view. It
// repaints on the next animation frame at the canvas's displayed size; where
// the photo does not reach, the canvas stays transparent and the page shows.

import { buildMesh, renderRelief, clampView, dragView, keyView, VIEW } from './relief.js';

/**
 * @param {{ canvas: HTMLCanvasElement, map: { depth: Float32Array, width: number, height: number },
 *   texture: { width: number, height: number, data: Uint8ClampedArray }, onRender?: (state: object) => void }} o
 */
export function createView3d({ canvas, map, texture, onRender }) {
  let mesh = buildMesh(map);
  const ctx = canvas.getContext('2d');
  const aspect = Math.min(1.25, Math.max(0.5, map.height / map.width));
  let view = { ...VIEW };
  let frame = 0, image = null, zbuffer = null, renders = 0, drawn = 0, drag = null, lastWidth = 0;

  function fit() {
    const cssWidth = canvas.clientWidth || canvas.parentElement?.clientWidth || 640;
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(64, Math.min(1100, Math.round(cssWidth * ratio)));
    const h = Math.max(48, Math.round(w * aspect));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; image = null; }
  }

  function draw() {
    frame = 0;
    if (!mesh) return;
    fit();
    if (!image) { image = ctx.createImageData(canvas.width, canvas.height); zbuffer = new Float32Array(canvas.width * canvas.height); }
    ({ drawn } = renderRelief(mesh, texture, image, { ...view, zbuffer }));
    ctx.putImageData(image, 0, 0);
    renders++;
    try { onRender?.({ ...view, renders, drawn, width: canvas.width, height: canvas.height }); } catch { /* a listener */ }
  }

  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };

  const onDown = e => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, view, id: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    canvas.focus({ preventScroll: true });
    e.preventDefault();
  };
  const onMove = e => {
    if (!drag || e.pointerId !== drag.id) return;
    view = dragView(drag.view, e.clientX - drag.x, e.clientY - drag.y, canvas.clientWidth || canvas.width);
    schedule();
  };
  const onUp = e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* released */ }
  };
  // While a finger turns the view, the page must not scroll.
  const onTouchMove = e => { if (drag) e.preventDefault(); };
  const onKey = e => {
    const next = keyView(view, e.key);
    if (!next) return;
    e.preventDefault();
    view = next;
    schedule();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('keydown', onKey);
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const w = canvas.clientWidth;
    if (w && w !== lastWidth) { lastWidth = w; schedule(); }
  }) : null;
  resize?.observe(canvas);
  draw();

  return {
    /** The current view: yaw, pitch (radians) and relief. */
    get view() { return { ...view }; },
    /** Turn to a view (kept inside the limits). */
    setView(v) { view = clampView({ ...view, ...v }); schedule(); },
    /** Back to the first view, keeping the relief. */
    reset() { view = clampView({ ...VIEW, relief: view.relief }); schedule(); },
    /** How many times it has painted, and how many pixels show the photo. */
    get stats() { return { renders, drawn }; },
    dispose() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      resize?.disconnect();
      // Let go of the large arrays at once (the mesh, the photo, the frame and its
      // depth buffer), and of the canvas's pixels, even if something still holds
      // this view; a page that runs many photos must not keep them all.
      mesh = null; texture = null; image = null; zbuffer = null; drag = null;
      canvas.width = 0; canvas.height = 0;
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('keydown', onKey);
    },
  };
}
