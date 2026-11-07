# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Reference text-to-video with the official modules (fp32, on WAN_DEVICE), with the same noise as the browser.
#   python gen_ref.py <ckpt> <prompt-id> [--emb fp32|<cfg>] [--size 480x272] [--frames 33] [--steps 4]
#                     [--sampler rcm|sf] [--out dir] [--decode]
import argparse, json, math, pathlib, subprocess, sys, time
import os as _os
WORK = pathlib.Path(_os.environ.get('WAN_WORK') or pathlib.Path(__file__).resolve().parents[2] / 'tmp')  # scratch: ref/, wan_base/, out/, onnx/
import numpy as np, torch
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import wanmods

def flow_times(sampler, steps):
    if sampler == 'rcm':
        ang = [math.atan(80.0), *[1.5, 1.4, 1.0][:steps - 1], 0.0]
        return [math.sin(a) / (math.cos(a) + math.sin(a)) for a in ang]
    lst = [1000, 750, 500, 250][:steps]
    return [5 * (1 - (1000 - d) / 1000) / (1 + 4 * (1 - (1000 - d) / 1000)) for d in lst] + [0.0]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt'); ap.add_argument('pid')
    ap.add_argument('--emb', default='fp32'); ap.add_argument('--size', default='480x272')
    ap.add_argument('--frames', type=int, default=33); ap.add_argument('--steps', type=int, default=4)
    ap.add_argument('--sampler', default='rcm'); ap.add_argument('--out', default=None)
    ap.add_argument('--tag', default=''); ap.add_argument('--seed', type=int, default=None)
    a = ap.parse_args()
    prompts = {p['id']: p for p in json.loads((HERE / 'prompts.json').read_text())}
    p = prompts[a.pid]; seed = a.seed if a.seed is not None else p['seed']
    ref = np.load(WORK / 'out' / 't5ref' / f"{a.pid}.npz")
    ctx = ref['fp32'] if a.emb == 'fp32' else (ref['bf16'] if a.emb == 'bf16' else np.load(WORK / 'out' / 't5ref' / f"{a.pid}.{a.emb}.npy"))
    W, H = map(int, a.size.split('x')); F = (a.frames - 1) // 4 + 1; h, w = H // 8, W // 8
    out = pathlib.Path(a.out or WORK / 'out' / 'ref'); out.mkdir(parents=True, exist_ok=True)
    name = f"{a.pid}_{pathlib.Path(a.ckpt).stem[:12]}_{a.sampler}{a.steps}_{a.emb}_{W}x{H}x{a.frames}{a.tag}"
    model, _, _ = wanmods.load_dit(a.ckpt); model = model.to(wanmods.DEVICE)
    n = 16 * F * h * w
    ts = flow_times(a.sampler, a.steps)
    x = wanmods.noise(seed, 0, n).astype(np.float64) * ts[0]
    seq = F * (h // 2) * (w // 2)
    c = torch.from_numpy(ctx.astype(np.float32)).to(wanmods.DEVICE)
    t0 = time.time()
    for i in range(a.steps):
        xin = torch.from_numpy(x.reshape(16, F, h, w).astype(np.float32)).to(wanmods.DEVICE)
        with torch.no_grad():
            v = model([xin], torch.tensor([ts[i] * 1000], device=wanmods.DEVICE), [c], seq_len=seq)[0].float().cpu().numpy().reshape(-1).astype(np.float64)
        x0 = x - ts[i] * v
        x = (1 - ts[i + 1]) * x0 + ts[i + 1] * wanmods.noise(seed, i + 1, n) if ts[i + 1] > 0 else x0
    lat = x.reshape(16, F, h, w).astype(np.float32)
    np.save(out / f'{name}.latent.npy', lat)
    del model; wanmods.empty_cache()
    vae = wanmods.load_vae(wanmods.DEVICE)
    vid = wanmods.vae_decode(vae, torch.from_numpy(lat))  # [3, T, H, W]
    frames = ((vid.permute(1, 2, 3, 0).cpu().numpy() + 1) * 127.5).round().clip(0, 255).astype(np.uint8)
    np.save(out / f'{name}.frames.npy', frames)
    proc = subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', '16', '-i', '-',
                           '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', str(out / f'{name}.mp4')], input=frames.tobytes())
    print(name, f'{time.time() - t0:.0f}s', 'ok' if proc.returncode == 0 else 'ffmpeg failed', flush=True)

if __name__ == '__main__':
    main()
