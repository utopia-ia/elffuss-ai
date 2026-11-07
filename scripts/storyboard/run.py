# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# A storyboard video from a plan (JSON): keyframes with SANA-Sprint, clips between them with
# Wan 2.1 VACE (rCM base, 4 steps), stitched into one MP4, plus a frame sheet and the previews.
#   python -I run.py <plan.json> [--tag x] [--base rcm|vace] [--steps 4] [--enc vae|tae]
#                    [--size 832x480] [--frames 49] [--only-keyframes] [--reuse-keyframes]
# Plan: { "name", "size", "seed", "style", "shots": [{ "prompt", "image"?, "from"?, "t"? }],
#         "clips": [prompt, …] (one fewer than shots), "carry": 0 }
import argparse, json, pathlib, sys, time
import numpy as np
import torch
from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT, wan_embeddings, write_mp4, sheet, spread, fit  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plan'); ap.add_argument('--tag', default='')
    ap.add_argument('--base', default='rcm'); ap.add_argument('--steps', type=int, default=None)
    ap.add_argument('--enc', default='vae'); ap.add_argument('--size', default=None)
    ap.add_argument('--frames', type=int, default=49); ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--carry', type=int, default=None, help='frames of the previous clip given as context to the next')
    ap.add_argument('--only-keyframes', action='store_true'); ap.add_argument('--reuse-keyframes', action='store_true')
    ap.add_argument('--decode', default='tae')
    a = ap.parse_args()
    plan = json.loads(pathlib.Path(a.plan).read_text())
    W, H = map(int, (a.size or plan.get('size', '832x480')).split('x'))
    seed = plan.get('seed', 1)
    steps = a.steps or (4 if a.base == 'rcm' else 25)
    carry = plan.get('carry', 0) if a.carry is None else a.carry
    name = plan['name'] + (f'-{a.tag}' if a.tag else '')
    out = OUT / name; out.mkdir(parents=True, exist_ok=True)
    kdir = OUT / plan['name'] / 'keyframes'; kdir.mkdir(parents=True, exist_ok=True)
    style = plan.get('style', '')
    t_all = time.time()

    # 1. keyframes
    keys, kprev = [], []
    if a.reuse_keyframes and all((kdir / f'k{i}.png').exists() for i in range(len(plan['shots']))):
        keys = [Image.open(kdir / f'k{i}.png').convert('RGB') for i in range(len(plan['shots']))]
    else:
        import keyframes as KF
        for i, s in enumerate(plan['shots']):
            pv = []
            if s.get('image'):
                img = fit(Image.open(OUT / s['image']), W, H)
            else:
                prompt = s['prompt'] + (', ' + style if style else '')
                src = s.get('from')
                init = None if src is None else (keys[src] if isinstance(src, int) else Image.open(OUT / src))
                img = KF.keyframe(prompt, W, H, s.get('seed', seed), init=init, t=s.get('t', 1.3), previews=pv)
            img.save(kdir / f'k{i}.png'); keys.append(img)
            for j, p in enumerate(pv):
                p.save(kdir / f'k{i}_step{j}.png')
            kprev.append(pv)
        KF.release()
    sheet([('keyframes ' + ' | '.join(f'k{i}' for i in range(len(keys))), keys)], out / 'keyframes.png')
    if a.only_keyframes:
        print('keyframes in', kdir); return

    # 2. clips
    import transitions as TR
    prompts = [c + (', ' + style if style else '') for c in plan['clips']]
    embs = wan_embeddings(prompts + ([TR.NEG] if a.base != 'rcm' else []))
    neg = embs[len(prompts)] if a.base != 'rcm' else None
    T = a.frames
    video, rows, pv_rows = [], [], []
    prev = None
    for i, emb in enumerate(embs[:len(prompts)]):
        known = {0: keys[i], T - 1: keys[i + 1]}
        if carry and prev is not None:
            known = {j: Image.fromarray(prev[-carry + j]) for j in range(carry)}; known[T - 1] = keys[i + 1]
        pv = []
        lat = TR.clip(emb, known, T=T, H=H, W=W, seed=seed + 100 * i, base=a.base, steps=steps, enc=a.enc, scale=a.scale, previews=pv, neg_emb=neg)
        fr = TR.decode_tae(lat) if a.decode == 'tae' else TR.decode_vae(lat)
        np.save(out / f'clip{i}.latent.npy', lat.numpy())
        write_mp4(fr, out / f'clip{i}.mp4')
        new = fr if not video else fr[(carry if carry and prev is not None else 1):]
        video.append(new); prev = fr
        rows.append((f'clip {i}: {plan["clips"][i][:110]}', [Image.fromarray(fr[j]) for j in spread(len(fr), 8)]))
        # the live preview: each step's x0 through the tiny decoder, middle frame
        pvr = []
        for x0 in pv[:6]:
            f = TR.decode_tae(x0)
            pvr.append(Image.fromarray(f[len(f) // 2]))
        pv_rows.append((f'clip {i} previews: x0 after each step (middle frame)', pvr))
    full = np.concatenate(video)
    write_mp4(full, out / f'{name}.mp4')
    sheet([('keyframes', keys)] + rows + pv_rows, out / f'{name}.sheet.png')
    meta = dict(plan=plan, size=f'{W}x{H}', frames=int(len(full)), seconds=round(len(full) / 16, 2), base=a.base, steps=steps,
                enc=a.enc, carry=carry, scale=a.scale, decode=a.decode, minutes=round((time.time() - t_all) / 60, 1))
    (out / 'meta.json').write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    print('done', out / f'{name}.mp4', meta['frames'], 'frames', meta['minutes'], 'min', flush=True)


if __name__ == '__main__':
    main()
