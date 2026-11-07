# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Decoders compared on the same latents: official Wan VAE (frames.npy from gen_ref) vs TAE variants.
import sys, pathlib, numpy as np, torch
import os as _os
WORK = pathlib.Path(_os.environ.get('WAN_WORK') or pathlib.Path(__file__).resolve().parents[2] / 'tmp')  # scratch: ref/, wan_base/, out/, onnx/
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(WORK / 'ref' / 'taehv')); sys.path.insert(0, str(HERE))
from taehv import TAEHV
import wanmods
mean = torch.tensor(wanmods.VAE_MEAN).view(1, 1, 16, 1, 1); std = torch.tensor(wanmods.VAE_STD).view(1, 1, 16, 1, 1)
def psnr(a, b):
    return 10 * np.log10(255.0 ** 2 / np.mean((a.astype(np.float32) - b.astype(np.float32)) ** 2))
for stem in sys.argv[1:]:
    lat = torch.from_numpy(np.load(stem + '.latent.npy'))  # [16, F, H, W] normalised (DiT space)
    ref = np.load(stem + '.frames.npy')  # [T, H, W, 3]
    x = lat.permute(1, 0, 2, 3)[None]  # NTCHW
    for name, scaled in (('taew2_1', False), ('lighttaew2_1', False), ('lighttaew2_1', True)):
        m = TAEHV(str(WORK / 'lae' / f'{name}.safetensors')).to(wanmods.DEVICE).eval()
        inp = x * std + mean if scaled else x
        with torch.no_grad():
            y = m.decode_video(inp.to(wanmods.DEVICE), parallel=True, show_progress_bar=False)  # NTCHW [0,1]
        fr = (y[0].permute(0, 2, 3, 1).cpu().numpy() * 255).round().clip(0, 255).astype(np.uint8)
        n = min(len(fr), len(ref))
        print(pathlib.Path(stem).name, name, 'unscaled' if scaled else 'raw', 'frames', len(fr), 'vs', len(ref), f'PSNR {psnr(fr[:n], ref[:n]):.2f} dB', flush=True)
        np.save(stem + f'.{name}{"_s" if scaled else ""}.frames.npy', fr)
