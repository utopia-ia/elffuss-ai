# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Keyframes of a storyboard with SANA-Sprint 0.6B: the first from text (or the user's photo),
# the next ones by SDEdit (img2img) from an earlier keyframe so the subject and the place stay.
# Every step's x0 is decoded too, the preview the page would fade in.
import pathlib, sys, time
import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import DEVICE, SANA_CACHE, snapshot, fit, empty_cache  # noqa: E402

_pipes = {}


def pipes():
    if not _pipes:
        from diffusers import SanaSprintPipeline, SanaSprintImg2ImgPipeline
        snap = snapshot('Efficient-Large-Model/Sana_Sprint_0.6B_1024px_diffusers', cache_dir=SANA_CACHE)
        t2i = SanaSprintPipeline.from_pretrained(snap, torch_dtype=torch.bfloat16).to(DEVICE)
        t2i.vae.to(torch.float32)
        i2i = SanaSprintImg2ImgPipeline.from_pipe(t2i)
        _pipes.update(t2i=t2i, i2i=i2i)
    return _pipes['t2i'], _pipes['i2i']


def release():
    _pipes.clear(); empty_cache()


def _decode(pipe, lat):
    with torch.no_grad():
        img = pipe.vae.decode(lat.to(torch.float32) / pipe.vae.config.scaling_factor, return_dict=False)[0]
    return Image.fromarray(((img[0].permute(1, 2, 0).float().cpu().numpy() + 1) * 127.5).clip(0, 255).astype(np.uint8))


def keyframe(prompt, w, h, seed, init=None, t=1.3, steps=2, previews=None):
    """One keyframe at w×h (generated near 1024² and fitted). init: a PIL image for SDEdit from
    TrigFlow time t (π/2 is pure noise; diffusers' `strength` only has two settings with 2 steps:
    below 0.5 it starts at 1.3, from 0.5 up at π/2, where the image is ignored)."""
    t2i, i2i = pipes()
    # SANA's bins are around one megapixel: generate there, then fit to the video size
    s = (1024 * 1024 / (w * h)) ** 0.5
    gw, gh = int(round(w * s / 32) * 32), int(round(h * s / 32) * 32)
    g = torch.Generator('cpu').manual_seed(seed)
    shots = []

    # each step's denoised prediction (x0) is the preview: catch it from the scheduler
    sch = t2i.scheduler; step = sch.step

    def spy(*a, **k):
        r = step(*a, **k)
        if previews is not None:
            shots.append(r[1].detach().clone() / sch.config.sigma_data)
        return r
    sch.step = spy
    t0 = time.time()
    common = dict(prompt=prompt, num_inference_steps=steps, generator=g, width=gw, height=gh)
    if init is None:
        if steps != 2:
            common['intermediate_timesteps'] = None
        img = t2i(**common).images[0]
    else:
        # the 2-step schedule [t, t·1.3/(π/2), 0]: strength 1 keeps all of it, so it starts at t
        img = i2i(image=fit(init, gw, gh), strength=1.0, max_timesteps=t, intermediate_timesteps=t * 1.3 / 1.5708, **common).images[0]
    sch.step = step
    if previews is not None:
        for lat in shots:
            previews.append(fit(_decode(t2i, lat), w, h))
    print(f'keyframe {gw}x{gh} {"t2i" if init is None else f"sdedit t={t}"} {time.time() - t0:.1f}s: {prompt[:80]}', flush=True)
    return fit(img, w, h)
