// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A 16-bit greyscale PNG for depth maps. Canvas only writes 8 bits per channel,
// which leaves 256 levels of depth; the 16-bit file keeps 65,536, enough for 3D
// tools and for comparing two maps. The writer and the reader are the core's
// (sdk/core/png.js), which need nothing but CompressionStream.

import { encodePngSamples, decodePng, filterRow } from '../core/png.js';

export { decodePng, filterRow };

/**
 * A 16-bit greyscale PNG of a depth map: 0 becomes 0 and 1 becomes 65535
 * (lighter is nearer, as in the 8-bit map).
 * @param {ArrayLike<number>} depth values 0-1, row by row
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Blob>} an `image/png` Blob
 */
export async function encodeDepthPng16(depth, width, height) {
  if (!(width > 0 && height > 0) || depth.length !== width * height) throw new RangeError('the depth map does not have width × height values');
  const data = new Uint16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, depth[i] || 0)) * 65535);
  return encodePngSamples({ width, height, channels: 1, bitDepth: 16, data });
}
