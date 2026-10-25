// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The camera of the detect page. It asks for the back camera first (a phone's
// main one) and, if that cannot be opened, for any camera. Nothing is recorded:
// the page takes one frame at a time from the live picture, and stopping ends
// every track so the browser releases the camera. Only this site's
// Permissions-Policy allows the camera (camera=(self)).

/** Errors that a second request with looser constraints cannot fix. */
const FINAL = new Set(['NotAllowedError', 'PermissionDeniedError', 'SecurityError', 'AbortError']);

/**
 * Open a camera.
 * @param {MediaDevices|undefined} media `navigator.mediaDevices`
 * @returns {Promise<MediaStream>}
 */
export async function openCamera(media) {
  if (!media?.getUserMedia) {
    const err = new Error('this page cannot use a camera');
    err.name = 'SecurityError';
    throw err;
  }
  try {
    return await media.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (err) {
    if (FINAL.has(err?.name)) throw err;
    return media.getUserMedia({ video: true, audio: false }).catch(() => { throw err; });
  }
}

/** Stop every track of a stream. Returns the tracks, now ended. */
export function stopStream(stream) {
  const tracks = stream?.getTracks?.() || [];
  for (const t of tracks) { try { t.stop(); } catch { /* already stopped */ } }
  return tracks;
}

/**
 * The text key of a camera failure (the page's strings hold the sentence).
 * @param {{ name?: string }} err a DOMException from getUserMedia or play()
 */
export function cameraErrorKey(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'camera.denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'camera.missing';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'camera.busy';
    case 'SecurityError':
    case 'NotSupportedError':
      return 'camera.blocked';
    default:
      return 'camera.failed';
  }
}

/**
 * Copy the current frame of a playing video into a canvas of its size. The
 * canvas then holds the frame being analysed, so it can be shown with its boxes
 * once the camera stops, and each run takes its own bitmap from it.
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 * @returns {boolean} false when the video has no frame yet
 */
export function captureFrame(video, canvas) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
  if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
  if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return true;
}
