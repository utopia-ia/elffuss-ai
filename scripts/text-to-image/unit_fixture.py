# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import json, sys, numpy as np, torch, torch.nn.functional as F
from diffusers import SCMScheduler
from diffusers.pipelines.pixart_alpha.pipeline_pixart_alpha import ASPECT_RATIO_1024_BIN
from diffusers.image_processor import PixArtImageProcessor
out = {}
rng = []
for seed, sizes in [(0, [48, 37]), (42, [32768, 32768]), (4294967295, [64])]:
    g = torch.Generator('cpu').manual_seed(seed)
    for n in sizes:
        x = torch.randn(n, generator=g).numpy()
        rng.append({'seed': seed, 'n': n, 'head': [float(v) for v in x[:20]], 'tail': [float(v) for v in x[-20:]], 'sum': float(x.astype(np.float64).sum())})
out['randn'] = rng
sched = {}
for steps in [1, 2, 3, 4]:
    s = SCMScheduler(); s.set_timesteps(steps, intermediate_timesteps=1.3 if steps == 2 else None)
    sched[steps] = [float(v) for v in s.timesteps]
out['timesteps'] = sched
r = np.random.RandomState(0)
lat, F_, noise = (r.randn(16).astype(np.float32) for _ in range(3))
steps = []
for s, t in [(1.5708, 1.3), (1.3, 0.0)]:
    st = torch.tensor(s, dtype=torch.float32); tt = torch.tensor(t, dtype=torch.float32)
    x = torch.from_numpy(lat)
    c = torch.sin(st) / (torch.cos(st) + torch.sin(st))
    k = torch.sqrt(c ** 2 + (1 - c) ** 2)
    xin = x / 0.5 * k
    v = ((1 - 2 * c) * xin + (1 - 2 * c + 2 * c ** 2) * torch.from_numpy(F_)) / k * 0.5
    x0 = torch.cos(st) * x - torch.sin(st) * v
    nxt = torch.cos(tt) * x0 + torch.sin(tt) * torch.from_numpy(noise) * 0.5
    steps.append({'s': s, 't': t, 'time': float(c), 'input': xin.tolist(), 'x0': x0.tolist(), 'next': nxt.tolist()})
out['step'] = {'latents': lat.tolist(), 'output': F_.tolist(), 'noise': noise.tolist(), 'cases': steps}
proc = PixArtImageProcessor(vae_scale_factor=32)
out['bins'] = [[w, h, *proc.classify_height_width_bin(h, w, ratios=ASPECT_RATIO_1024_BIN)] for w, h in
               [(1024, 1024), (1920, 1080), (1080, 1920), (800, 600), (600, 800), (512, 512), (2048, 256), (256, 2048), (1000, 777), (1152, 896)]]
img = r.randn(1, 3, 12, 20).astype(np.float32)
rc = PixArtImageProcessor.resize_and_crop_tensor(torch.from_numpy(img), 15, 11)
out['resize'] = {'in': img.ravel().tolist(), 'h': 12, 'w': 20, 'width': 15, 'height': 11, 'out': rc.numpy().ravel().tolist()}
json.dump(out, open(sys.argv[1], 'w'))
print('ok')
