# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Pull each frame's colour back to the keyframes: per channel mean and spread (in YCbCr) of the
# frame are moved to those of the two keyframes, blended by the frame's place in the clip.
# Few-step clips drift to more contrast and saturation in the middle; this undoes that, and in
# the browser it is a per-frame shader with six numbers.
#   python -I colormatch.py <result dir> [strength 0..1]
import json, pathlib, subprocess, sys
import numpy as np
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import write_mp4, sheet, spread  # noqa: E402


# YCbCr (BT.601, full range): luma and two chroma axes, linear, so the shader is one matrix
_M = np.array([[0.299, 0.587, 0.114], [-0.168736, -0.331264, 0.5], [0.5, -0.418688, -0.081312]], np.float32)
_Mi = np.linalg.inv(_M).astype(np.float32)


def to_lab(x):
    return x @ _M.T


def from_lab(x):
    return (x @ _Mi.T).round().clip(0, 255).astype(np.uint8)


def stats(lab):
    return lab.reshape(-1, 3).mean(0), lab.reshape(-1, 3).std(0) + 1e-6


def match(frames, k0, k1, strength=1.0):
    m0, s0 = stats(to_lab(np.asarray(k0, np.float32)))
    m1, s1 = stats(to_lab(np.asarray(k1, np.float32)))
    out = []
    n = len(frames)
    for i, f in enumerate(frames):
        a = i / (n - 1)
        mt, st = (1 - a) * m0 + a * m1, (1 - a) * s0 + a * s1
        lab = to_lab(f.astype(np.float32)); m, s = stats(lab)
        tm, ts = m + strength * (mt - m), s + strength * (st - s)
        out.append(from_lab((lab - m) / s * ts + tm))
    return np.stack(out)


def frames_of(p, W, H):
    r = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', str(p), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    return np.frombuffer(r, np.uint8).reshape(-1, H, W, 3)


if __name__ == '__main__':
    d = pathlib.Path(sys.argv[1]); k = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    meta = json.loads((d / 'meta.json').read_text())
    W, H = map(int, meta['size'].split('x'))
    kd = d.parent / meta['plan']['name'] / 'keyframes'
    keys = [Image.open(kd / f'k{i}.png').convert('RGB') for i in range(len(meta['plan']['shots']))]
    carry = meta.get('carry', 0)
    video, rows = [], []
    for i in range(len(meta['plan']['clips'])):
        fr = match(frames_of(d / f'clip{i}.mp4', W, H), keys[i], keys[i + 1], k)
        video.append(fr if not video else fr[(carry or 1):])
        rows.append((f'clip {i} colour-matched', [Image.fromarray(fr[j]) for j in spread(len(fr), 8)]))
    full = np.concatenate(video)
    write_mp4(full, d / f'{d.name}.cm.mp4')
    sheet([('keyframes', keys)] + rows, d / f'{d.name}.cm.sheet.png')
    print('done', d / f'{d.name}.cm.mp4')
