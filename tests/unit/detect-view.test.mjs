// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The detect page's pure pieces: the slider filter, how scores, thresholds,
// names and boxes are written, the drawing's geometry, the download's JSON and
// file names, and the camera's error texts and requests (with a fake browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { visible, percent, formatThreshold, className, roundBox, normalizeBox, colourSlots, drawingScale, chipRect, resultJson, downloadName } from '../../apps/detect/view.js';
import { openCamera, stopStream, cameraErrorKey, captureFrame } from '../../apps/detect/camera.js';

const objects = [
  { label: 'dog', score: 0.93, box: { xmin: 10.4, ymin: 20.6, xmax: 100.5, ymax: 200.49 } },
  { label: 'cat', score: 0.71, box: { xmin: 120, ymin: 40, xmax: 180, ymax: 210 } },
  { label: 'dog', score: 0.35, box: { xmin: 0, ymin: 0, xmax: 5, ymax: 5 } },
];

test('the slider keeps objects at or above it, in order', () => {
  assert.deepEqual(visible(objects, 0.5).map(o => o.score), [0.93, 0.71]);
  assert.deepEqual(visible(objects, 0.71).map(o => o.score), [0.93, 0.71]);
  assert.deepEqual(visible(objects, 0.3).length, 3);
  assert.deepEqual(visible(objects, 0.95), []);
  assert.deepEqual(visible(null, 0.5), []);
});

test('scores, thresholds and names as the page writes them', () => {
  assert.equal(percent(0.937), 94);
  assert.equal(percent(1.2), 100);
  assert.equal(percent(-1), 0);
  assert.equal(percent('x'), 0);
  assert.equal(formatThreshold(0.5, 'es'), '0,50');
  assert.equal(formatThreshold('0.35', 'en'), '0.35');
  const names = { dog: 'perro' };
  assert.equal(className('dog', 'es', names), 'perro');
  assert.equal(className('dog', 'en', names), 'dog');
  assert.equal(className('zebra', 'es', names), 'zebra', 'a missing name falls back to English');
  assert.equal(className('dog', 'es', null), 'dog');
});

test('boxes in whole pixels, and as fractions of the image', () => {
  assert.deepEqual(roundBox(objects[0].box), { xmin: 10, ymin: 21, xmax: 101, ymax: 200 });
  assert.deepEqual(normalizeBox({ xmin: 48, ymin: 36, xmax: 96, ymax: 72 }, 960, 720), { xmin: 0.05, ymin: 0.05, xmax: 0.1, ymax: 0.1 });
});

test('one colour slot per class, in the order the classes appear', () => {
  assert.deepEqual(colourSlots(objects, 4), [0, 1, 0]);
  assert.deepEqual(colourSlots([{ label: 'a' }, { label: 'b' }, { label: 'c' }], 2), [0, 1, 0]);
  assert.deepEqual(colourSlots([{ label: 'a' }], 0), [0]);
});

test('the drawing scales with the image, and labels stay inside it', () => {
  assert.deepEqual(drawingScale(960), { line: 3, font: 21 });
  assert.deepEqual(drawingScale(100), { line: 2, font: 12 });
  // Room above the box: the label sits on top of it.
  assert.deepEqual(chipRect({ xmin: 50, ymin: 100, xmax: 200, ymax: 300 }, 80, 20, 960, 720), { x: 50, y: 72, w: 94, h: 28 });
  // No room above: just inside the top edge.
  assert.deepEqual(chipRect({ xmin: 50, ymin: 10, xmax: 200, ymax: 300 }, 80, 20, 960, 720).y, 10);
  // Near the right edge: pulled back inside.
  const r = chipRect({ xmin: 940, ymin: 100, xmax: 960, ymax: 300 }, 80, 20, 960, 720);
  assert.equal(r.x + r.w, 960);
  // Wider than the image: as wide as the image.
  assert.equal(chipRect({ xmin: 0, ymin: 100, xmax: 10, ymax: 30 }, 5000, 20, 300, 200).w, 300);
});

test('the downloaded JSON: the objects above the slider, English names, rounded', () => {
  const text = resultJson({ source: 'foto.jpg', model: 'detect/rfdetr-nano', device: 'wasm', threshold: 0.5, result: { width: 960, height: 720, objects } });
  assert.ok(text.endsWith('\n'));
  const j = JSON.parse(text);
  assert.deepEqual(Object.keys(j), ['source', 'width', 'height', 'model', 'device', 'threshold', 'objects']);
  assert.deepEqual(j.objects, [
    { label: 'dog', score: 0.93, box: { xmin: 10, ymin: 21, xmax: 101, ymax: 200 } },
    { label: 'cat', score: 0.71, box: { xmin: 120, ymin: 40, xmax: 180, ymax: 210 } },
  ]);
  assert.equal(JSON.parse(resultJson({ source: 'x', model: 'm', device: 'wasm', threshold: 0.9, result: { width: 1, height: 1, objects } })).objects.length, 1);
});

test('download names come from the image name, without its extension or unsafe characters', () => {
  assert.equal(downloadName('foto.jpg', 'objetos', 'json'), 'foto-objetos.json');
  assert.equal(downloadName('mi.foto.de.vacaciones.png', 'cajas', 'png'), 'mi.foto.de.vacaciones-cajas.png');
  assert.equal(downloadName('a/b:c?.jpg', 'x', 'json'), 'a_b_c_-x.json');
  assert.equal(downloadName('', 'x', 'json'), 'image-x.json');
  assert.equal(downloadName('camara', 'objetos', 'json'), 'camara-objetos.json');
});

test('painting: a box and a label per object, colours from the palette slots, nothing written by hand', async () => {
  const { paint, drawOverlay } = await import('../../apps/detect/overlay.js');
  const calls = [];
  const g = new Proxy({ measureText: s => ({ width: s.length * 10 }) }, {
    get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])),
    set: (o, k, v) => { calls.push([`=${String(k)}`, v]); return true; },
  });
  const palette = { slots: ['var-accent', 'var-accent2'], text: 'var-bg', family: 'page-font' };
  paint(g, { width: 960, height: 720, objects, name: l => l.toUpperCase(), score: n => `${n}%`, palette });
  const rects = calls.filter(c => c[0] === 'strokeRect');
  assert.equal(rects.length, 3);
  assert.deepEqual(rects[0].slice(1), [10.4 + 1.5, 20.6 + 1.5, 100.5 - 10.4 - 3, 200.49 - 20.6 - 3], 'the stroke sits inside the box');
  assert.deepEqual(calls.filter(c => c[0] === '=strokeStyle').map(c => c[1]), ['var-accent', 'var-accent2', 'var-accent'], 'one colour per class');
  assert.deepEqual(calls.filter(c => c[0] === 'fillText').map(c => c[1]), ['DOG 93%', 'CAT 71%', 'DOG 35%']);
  assert.ok(calls.some(c => c[0] === '=font' && c[1] === '21px page-font'), 'the page\'s font, scaled');
  assert.ok(calls.filter(c => c[0] === '=fillStyle').every(c => palette.slots.includes(c[1]) || c[1] === palette.text), 'only palette colours');
  // drawOverlay sizes the canvas to the image and clears it first.
  const canvas = { width: 300, height: 150, getContext: () => g };
  calls.length = 0;
  drawOverlay(canvas, { width: 960, height: 720, objects: [], name: l => l, score: n => n, palette });
  assert.deepEqual([canvas.width, canvas.height], [960, 720]);
  assert.deepEqual(calls[0], ['clearRect', 0, 0, 960, 720]);
});

const domError = name => Object.assign(new Error(name), { name });

test('camera failures have a text each', () => {
  assert.equal(cameraErrorKey(domError('NotAllowedError')), 'camera.denied');
  assert.equal(cameraErrorKey(domError('PermissionDeniedError')), 'camera.denied');
  assert.equal(cameraErrorKey(domError('NotFoundError')), 'camera.missing');
  assert.equal(cameraErrorKey(domError('OverconstrainedError')), 'camera.missing');
  assert.equal(cameraErrorKey(domError('NotReadableError')), 'camera.busy');
  assert.equal(cameraErrorKey(domError('AbortError')), 'camera.busy');
  assert.equal(cameraErrorKey(domError('SecurityError')), 'camera.blocked');
  assert.equal(cameraErrorKey(domError('NotSupportedError')), 'camera.blocked', 'what a browser without camera prompts answers');
  assert.equal(cameraErrorKey(domError('TypeError')), 'camera.failed');
  assert.equal(cameraErrorKey(null), 'camera.failed');
});

function fakeMedia(answers) {
  const calls = [];
  return { calls, getUserMedia: async c => { calls.push(c); const a = answers.shift(); if (a instanceof Error) throw a; return a; } };
}

test('the back camera first, then any camera; a refusal is final', async () => {
  const stream = { id: 's' };
  let m = fakeMedia([stream]);
  assert.equal(await openCamera(m), stream);
  assert.deepEqual(m.calls, [{ video: { facingMode: 'environment' }, audio: false }]);
  m = fakeMedia([domError('OverconstrainedError'), stream]);
  assert.equal(await openCamera(m), stream);
  assert.deepEqual(m.calls[1], { video: true, audio: false });
  m = fakeMedia([domError('NotAllowedError'), stream]);
  await assert.rejects(openCamera(m), { name: 'NotAllowedError' });
  assert.equal(m.calls.length, 1, 'no second prompt after a refusal');
  m = fakeMedia([domError('NotFoundError'), domError('NotReadableError')]);
  await assert.rejects(openCamera(m), { name: 'NotFoundError' }, 'the first reason is the one reported');
  await assert.rejects(openCamera(undefined), { name: 'SecurityError' });
});

test('stopping ends every track; a frame is copied at the video\'s size, or not at all', () => {
  const tracks = [{ stopped: 0, stop() { this.stopped++; } }, { stopped: 0, stop() { throw new Error('gone'); } }];
  assert.equal(stopStream({ getTracks: () => tracks }).length, 2);
  assert.equal(tracks[0].stopped, 1);
  assert.deepEqual(stopStream(null), []);
  const draws = [];
  const canvas = { width: 300, height: 150, getContext: () => ({ drawImage: (...a) => draws.push(a.slice(1)) }) };
  assert.equal(captureFrame(null, canvas), false);
  assert.equal(captureFrame({ readyState: 1, videoWidth: 640, videoHeight: 480 }, canvas), false, 'no frame yet');
  assert.equal(captureFrame({ readyState: 4, videoWidth: 0, videoHeight: 0 }, canvas), false, 'no size yet');
  assert.deepEqual(draws, []);
  assert.equal(captureFrame({ readyState: 4, videoWidth: 640, videoHeight: 480 }, canvas), true);
  assert.deepEqual([canvas.width, canvas.height, draws], [640, 480, [[0, 0, 640, 480]]]);
});
