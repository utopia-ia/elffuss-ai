// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The two file writers of the video task, without a browser: the MP4 has its
// index before its data, sample tables that add up, composition offsets and an
// edit list when frames are reordered, and offsets that point at each sample;
// the WebM has its header, segment, clusters at key frames and cues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeMp4, readBoxes, timing, audioSpecificConfig } from '../../sdk/video/mp4.js';
import { writeWebm, readElements, opusHead } from '../../sdk/video/webm.js';
import { defaultBitrate, avcCandidates, chooseCodecs } from '../../sdk/video/encode.js';

const join = parts => { const n = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const find = (boxes, path) => { let cur = boxes, hit = null; for (const t of path.split('/')) { hit = cur.find(b => b.type === t); if (!hit) return null; cur = hit.children || []; } return hit; };
const AVCC = Uint8Array.of(1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80);

function video(n, reorder = false) {
  const pts = reorder ? [0, 3, 1, 2, 6, 4, 5, 9, 7, 8].slice(0, n) : [...Array(n).keys()];
  return { kind: 'video', codec: 'avc1', width: 64, height: 32, timescale: 30000, description: AVCC,
    samples: pts.map((p, i) => ({ data: Uint8Array.of(i, i, i, i, i), pts: p * 1000, duration: 1000, key: i === 0 })) };
}

test('MP4: ftyp, moov before mdat, the tracks and their tables', () => {
  const audio = { kind: 'audio', codec: 'mp4a', sampleRate: 48000, channels: 2, timescale: 48000, samples: [...Array(4)].map((_, i) => ({ data: Uint8Array.of(9, i), pts: i * 1024, duration: 1024, key: true })) };
  const file = join(writeMp4({ video: video(10), audio }));
  const boxes = readBoxes(file);
  assert.deepEqual(boxes.map(b => b.type), ['ftyp', 'moov', 'mdat']);
  const moov = boxes[1];
  assert.equal(moov.children.filter(b => b.type === 'trak').length, 2);
  const vt = moov.children.find(b => b.type === 'trak');
  assert.ok(find(vt.children, 'mdia/minf/stbl/stsd'));
  assert.equal(find(vt.children, 'mdia/minf/stbl/ctts'), null, 'no reordering: no composition offsets');
  // Every video sample's bytes are where the index says (stco + stsz).
  const stbl = find(vt.children, 'mdia/minf/stbl');
  const dv = new DataView(file.buffer);
  const stco = stbl.children.find(b => b.type === 'stco'), stsc = stbl.children.find(b => b.type === 'stsc');
  const first = dv.getUint32(stco.offset + 16);
  assert.equal(file[first], 0, 'the first chunk starts with sample 0');
  const perChunk = dv.getUint32(stsc.offset + 20);
  assert.ok(perChunk >= 1);
  assert.equal(String.fromCharCode(...file.subarray(boxes[2].offset + 4, boxes[2].offset + 8)), 'mdat');
});

test('MP4: reordered frames get composition offsets and an edit list', () => {
  const t = timing(video(10, true).samples);
  assert.ok(t.cts.every(c => c >= 0));
  assert.equal(t.dts[0], 0);
  const file = join(writeMp4({ video: video(10, true) }));
  const vt = readBoxes(file)[1].children.find(b => b.type === 'trak');
  assert.ok(find(vt.children, 'mdia/minf/stbl/ctts'));
  assert.ok(find(vt.children, 'edts'));
  assert.throws(() => writeMp4({ video: { ...video(1), samples: [] } }), RangeError);
});

test('AAC config and Opus header', () => {
  assert.deepEqual([...audioSpecificConfig(48000, 2)], [0x11, 0x90]);
  const h = opusHead(2, 48000);
  assert.equal(String.fromCharCode(...h.subarray(0, 8)), 'OpusHead');
  assert.equal(h.length, 19);
});

test('WebM: EBML header then one Segment with info, tracks, clusters and cues', () => {
  const blocks = [...Array(60).keys()].map(i => ({ data: Uint8Array.of(i), us: Math.round(i * 1e6 / 30), key: i % 30 === 0 }));
  const file = join(writeWebm({ video: { codec: 'vp9', width: 64, height: 32, blocks }, audio: { sampleRate: 48000, channels: 2, blocks: [{ data: Uint8Array.of(1), us: 0, key: true }] }, durationUs: 2e6 }));
  const top = readElements(file);
  assert.deepEqual(top.map(e => e.id), ['1a45dfa3', '18538067']);
  const inside = readElements(file, top[1].at, top[1].at + top[1].size).map(e => e.id);
  assert.equal(inside.filter(id => id === '1f43b675').length, 2, 'a cluster per key frame');
  assert.deepEqual([inside[0], inside[1], inside.at(-1)], ['1549a966', '1654ae6b', '1c53bb6b']);
});

test('encoder choices: bitrate, H.264 levels, and no WebCodecs', async () => {
  assert.ok(defaultBitrate(1920, 1080, 30) >= 12e6);
  assert.equal(avcCandidates(1920, 1080, 30)[0], 'avc1.640028');
  assert.equal(avcCandidates(1920, 1080, 60)[0], 'avc1.64002a');
  assert.deepEqual(await chooseCodecs({ width: 64, height: 64, fps: 30, scope: {} }), { container: null, reason: 'webcodecs-unavailable' });
  const fake = { VideoFrame: function () {}, VideoEncoder: { isConfigSupported: async c => ({ supported: !c.codec.startsWith('avc1'), config: c }) }, AudioEncoder: { isConfigSupported: async c => ({ supported: c.codec === 'opus', config: c }) } };
  fake.VideoEncoder = Object.assign(function () {}, fake.VideoEncoder);
  fake.AudioEncoder = Object.assign(function () {}, fake.AudioEncoder);
  const c = await chooseCodecs({ width: 64, height: 64, fps: 30, audio: true, scope: fake });
  assert.equal(c.container, 'webm', 'without H.264 the video falls back to WebM');
  assert.equal(c.audio.codec, 'opus');
});
