// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// OGG (Opus) files made in the page, much smaller than WAV: the browser's own
// Opus encoder (WebCodecs AudioEncoder) at 48 kHz, after resampling with an
// OfflineAudioContext, and the Ogg pages written here (RFC 3533 and 7845:
// OpusHead, OpusTags, then the packets, granule positions in 48 kHz samples).
// Offered only where the browser has an Opus encoder.

const RATE = 48000;

/** True when this browser can encode Opus. */
export async function canEncodeOgg() {
  if (typeof AudioEncoder === 'undefined' || typeof OfflineAudioContext === 'undefined') return false;
  try { return (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: RATE, numberOfChannels: 2, bitrate: 160000 })).supported === true; }
  catch { return false; }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
/** The CRC-32 of Ogg (polynomial 0x04c11db7, no reflection, initial 0). */
export function oggCrc(bytes) {
  let c = 0;
  for (const b of bytes) c = ((c << 8) ^ CRC[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c;
}

/** One Ogg page holding `packets` (each under 255 × 255 bytes). */
export function oggPage(packets, { serial, seq, granule, first = false, last = false }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const body = packets.reduce((s, p) => s + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + body);
  const v = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  page[5] = (first ? 2 : 0) | (last ? 4 : 0);
  v.setBigInt64(6, BigInt(granule), true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { page.set(p, o); o += p.length; }
  v.setUint32(22, oggCrc(page), true);
  return page;
}

/** OpusHead and OpusTags of RFC 7845. */
export function opusHeaders(channels, inputRate, preSkip) {
  const head = new Uint8Array(19);
  const v = new DataView(head.buffer);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  head[8] = 1; head[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputRate, true);
  const vendor = new TextEncoder().encode('Elffuss');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  const tv = new DataView(tags.buffer);
  tags.set(new TextEncoder().encode('OpusTags'), 0);
  tv.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  tv.setUint32(12 + vendor.length, 0, true);
  return [head, tags];
}

/**
 * Encode planar channels as an OGG Opus file.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {Promise<Blob>}
 */
export async function encodeOgg(channels, sampleRate) {
  const n = channels.length;
  const frames = Math.ceil((channels[0].length * RATE) / sampleRate);
  const off = new OfflineAudioContext(n, frames, RATE);
  const src = off.createBuffer(n, channels[0].length, sampleRate);
  channels.forEach((c, i) => src.copyToChannel(c, i));
  const node = off.createBufferSource();
  node.buffer = src;
  node.connect(off.destination);
  node.start();
  const rendered = await off.startRendering();
  const pcm = Array.from({ length: n }, (_, i) => rendered.getChannelData(i));

  const packets = [];
  let preSkip = 312;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      packets.push({ data: b, duration: Math.round(((chunk.duration || 20000) * RATE) / 1e6) });
      const desc = meta?.decoderConfig?.description;
      if (desc && desc.byteLength >= 12) preSkip = new DataView(desc instanceof ArrayBuffer ? desc : desc.buffer, desc.byteOffset || 0).getUint16(10, true);
    },
    error: e => { throw e; },
  });
  encoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: n, bitrate: n > 1 ? 160000 : 96000 });
  const block = RATE; // one second per AudioData
  for (let at = 0; at < frames; at += block) {
    const len = Math.min(block, frames - at);
    const planar = new Float32Array(len * n);
    for (let c = 0; c < n; c++) planar.set(pcm[c].subarray(at, at + len), c * len);
    const data = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: len, numberOfChannels: n, timestamp: Math.round((at * 1e6) / RATE), data: planar });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();

  const serial = (Math.random() * 0xffffffff) >>> 0;
  const [head, tags] = opusHeaders(n, sampleRate, preSkip);
  const pages = [oggPage([head], { serial, seq: 0, granule: 0, first: true }), oggPage([tags], { serial, seq: 1, granule: 0 })];
  let granule = 0, seq = 2, group = [], size = 0;
  const total = frames + preSkip;
  packets.forEach((p, i) => {
    group.push(p.data); size += p.data.length; granule += p.duration;
    const last = i === packets.length - 1;
    if (last || size > 4000 || group.length >= 50) {
      pages.push(oggPage(group, { serial, seq: seq++, granule: last ? total : granule, last }));
      group = []; size = 0;
    }
  });
  return new Blob(pages, { type: 'audio/ogg' });
}
