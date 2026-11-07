# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Keyframes with Wan itself instead of SANA: a one-frame "video" (1 latent frame) with the same
# rCM transformer and UMT5 states, and img2img by SDEdit (the previous keyframe, VAE-encoded, noised
# to time t and denoised from there). If good enough, the storyboard needs one model, not two.
#   python -I wan_keyframe.py <plan.json> [--tag x]
import argparse, json, math, pathlib, sys, time
import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import OUT, DEVICE, wan_embeddings, fit, sheet  # noqa: E402
import transitions as TR  # noqa: E402


def sdedit_times(strength, steps=4):
    """rCM times from the one nearest to `strength` down to 0 (all of them for 1.0)."""
    ts = TR.rcm_times(steps)[:-1]
    if strength >= 0.999:
        return TR.rcm_times(steps)
    start = strength
    rest = [t for t in ts if t < start - 1e-3]
    return [start, *rest, 0.0]


def keyframe(emb, W, H, seed, init=None, strength=1.0):
    tr = TR.transformer('rcm')
    h, w = H // 8, W // 8
    cond = TR.conditioning({}, 1, H, W).to(DEVICE, TR.DT)  # nothing known: plain generation
    sc = torch.zeros(len(tr.config.vace_layers), device=DEVICE, dtype=TR.DT)  # VACE off
    g = torch.Generator('cpu').manual_seed(seed)
    ts = TR.rcm_times(4) if init is None else sdedit_times(strength)
    noise = torch.randn(1, 16, 1, h, w, generator=g)
    if init is None:
        x = noise * ts[0]
    else:
        a = torch.from_numpy(np.asarray(init.convert('RGB').resize((W, H)), np.float32) / 127.5 - 1).permute(2, 0, 1)[None, :, None]
        x0 = TR.encode(a, 'vae')
        x = (1 - ts[0]) * x0 + ts[0] * noise
    ctx = emb[None].to(DEVICE, TR.DT)
    for i in range(len(ts) - 1):
        with torch.no_grad():
            v = tr(hidden_states=x.to(DEVICE, TR.DT), timestep=torch.tensor([ts[i] * 1000], device=DEVICE), encoder_hidden_states=ctx,
                   control_hidden_states=cond, control_hidden_states_scale=sc, return_dict=False)[0].float().cpu()
        x0 = x - ts[i] * v
        x = (1 - ts[i + 1]) * x0 + ts[i + 1] * torch.randn(x.shape, generator=g) if ts[i + 1] > 0 else x0
    return Image.fromarray(TR.decode_vae(x[0])[0])


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('plan'); ap.add_argument('--tag', default='wankf')
    a = ap.parse_args()
    plan = json.loads(pathlib.Path(a.plan).read_text())
    W, H = map(int, plan.get('size', '832x480').split('x'))
    style = plan.get('style', '')
    out = OUT / f"{plan['name']}-{a.tag}"; out.mkdir(parents=True, exist_ok=True)
    prompts = [s['prompt'] + ', ' + style for s in plan['shots'] if not s.get('image')]
    embs = iter(wan_embeddings(prompts))
    keys = []
    for i, s in enumerate(plan['shots']):
        t0 = time.time()
        if s.get('image'):
            img = fit(Image.open(OUT / s['image']), W, H)
        else:
            src = s.get('from')
            img = keyframe(next(embs), W, H, s.get('seed', plan.get('seed', 1)), init=None if src is None else keys[src], strength=s.get('strength', 1.0))
        img.save(out / f'k{i}.png'); keys.append(img)
        print(f'wan keyframe {i} {time.time() - t0:.1f}s', flush=True)
    sheet([('Wan keyframes ' + ' | '.join(f'k{i}' for i in range(len(keys))), keys)], out / 'keyframes.png')


if __name__ == '__main__':
    main()
