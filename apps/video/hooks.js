// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The integrations the video site can offer, each behind a hook that does
// nothing until its module ships with the site: an image made with AI (as the
// input), music made with AI (as the soundtrack), and a video made from text
// (an advanced mode). A module ships when apps/video/app.json lists it in
// `modules` (the build copies sdk/<module>/ and config.js says so); until then
// nothing is imported and nothing is requested. What each hook expects of its
// module is written next to it; a module that does not offer it stays off.

import config from './config.js';

/** Which module and which export each integration uses. */
export const INTEGRATIONS = Object.freeze({
  // image.generate({ prompt, aspect?, signal?, onProgress? }) → Blob | { blob }
  image: { module: 'image', fn: 'generate' },
  // audio.music({ prompt?, seconds, signal?, onProgress? }) → Blob | { blob } | { sampleRate, channels }
  music: { module: 'audio', fn: 'music' },
  // video.generate({ prompt, seconds, size, seed, image?, onProgress, signal }) → { blob, … }; supported?() → boolean
  textToVideo: { module: 'video-gen', fn: 'generate', check: 'supported' },
});

/** The modules this build of the site ships. */
export function shipped(cfg = config) {
  return Array.isArray(cfg.modules) ? cfg.modules : [];
}

/**
 * The function of an integration, or null when its module is not in this build,
 * does not export it, or says this browser cannot run it.
 * @param {keyof typeof INTEGRATIONS} name
 * @returns {Promise<Function|null>}
 */
export async function integration(name, { cfg = config, load = m => import(`./sdk/${m}/index.js`) } = {}) {
  const spec = INTEGRATIONS[name];
  if (!spec || !shipped(cfg).includes(spec.module)) return null;
  try {
    const mod = await load(spec.module);
    const fn = mod?.[spec.fn];
    if (typeof fn !== 'function') return null;
    if (spec.check && typeof mod[spec.check] === 'function' && !(await mod[spec.check]())) return null;
    return fn;
  } catch {
    return null;
  }
}

/** A Blob out of what an integration gives (a Blob, or an object holding one). */
export function blobOf(out) {
  if (typeof Blob !== 'undefined' && out instanceof Blob) return out;
  if (out && typeof Blob !== 'undefined' && out.blob instanceof Blob) return out.blob;
  return null;
}
