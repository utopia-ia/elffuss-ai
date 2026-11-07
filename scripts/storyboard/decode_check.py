# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# The same clip latents through the full Wan VAE and the tiny decoder: is the colour drift the decoder's?
#   python -I decode_check.py <result dir> <W> <H>
import pathlib, sys
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import torch, transitions as TR
from common import write_mp4
d = pathlib.Path(sys.argv[1])
lat = torch.from_numpy(np.load(d / 'clip0.latent.npy'))
v = TR.decode_vae(lat); t = TR.decode_tae(lat)
write_mp4(v, d / 'clip0.vae.mp4')
def sat(x):
    x = x.astype(np.float32); mx = x.max(-1); mn = x.min(-1); return float(((mx - mn) / (mx + 1e-3)).mean())
for name, f in (('vae', v), ('tae', t)):
    print(name, 'frames', len(f), 'sat', [round(sat(f[j]), 3) for j in range(0, len(f), 8)], 'contrast', [round(float(f[j].astype(np.float32).std()), 1) for j in range(0, len(f), 8)])
mse = ((v.astype(np.float32) - t.astype(np.float32)) ** 2).mean()
print('tae vs vae PSNR', round(float(10 * np.log10(255 ** 2 / mse)), 1), 'dB')
