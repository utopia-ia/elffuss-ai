# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import sys, json, numpy as np, onnxruntime as ort
from PIL import Image
ref, embp, encp, tfp, vaep, outp = sys.argv[1:7]
d = np.load(ref + '/tensors.npz'); meta = json.load(open(ref + '/meta.json'))
E = np.load(embp, mmap_mode='r')
S = lambda p: ort.InferenceSession(p, providers=['CPUExecutionProvider'])
ids = d['input_ids'][0]; mask = d['attention_mask'][0]; L = len(ids); n = int(mask.sum())
hid = S(encp).run(None, {'embeds': np.ascontiguousarray(E[ids[:n]][None]).astype(np.float32)})[0]
window = list(range(L - 299, L))
keep = [0] + [p for p in window if p < n]
cap = hid[:, keep]
steps = meta['steps']
ts = [1.5708, 1.3, 0.0] if steps == 2 else list(np.linspace(1.5708, 0, steps + 1).astype(np.float32))
ts = [np.float32(t) for t in ts]
sd = np.float32(0.5)
x = d['randn0'].astype(np.float32) * sd
tf = S(tfp)
for i in range(steps):
    s, t = ts[i], ts[i + 1]
    c = np.float32(np.sin(s) / (np.cos(s) + np.sin(s)))
    k = np.float32(np.sqrt(c * c + (1 - c) ** 2))
    xin = (x / sd) * k
    F = tf.run(None, {'latents': xin, 'caption': cap, 'timestep': np.array([c], np.float32), 'guidance': np.array([0.45], np.float32)})[0]
    v = ((1 - 2 * c) * xin + (1 - 2 * c + 2 * c * c) * F) / k * sd
    x0 = np.cos(s) * x - np.sin(s) * v
    noise = d[f'randn{i + 1}'].astype(np.float32) * sd
    x = (np.cos(t) * x0 + np.sin(t) * noise).astype(np.float32)
img = S(vaep).run(None, {'latents': (x0 / sd / np.float32(0.41407)).astype(np.float32)})[0][0]
u8 = np.round(np.clip(img * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8).transpose(1, 2, 0)
Image.fromarray(u8).save(outp)
r = np.asarray(Image.open(ref + '/image.png').convert('RGB')).astype(np.float64)
mse = ((u8.astype(np.float64) - r) ** 2).mean()
print(f'{outp}: PSNR vs reference {10 * np.log10(255 ** 2 / mse):.2f} dB, caption tokens {len(keep)}')
