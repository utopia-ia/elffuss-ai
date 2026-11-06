# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Export the DiT graphs (ctx + parts) for a checkpoint, and a test vector.
#   python export_dit.py <ckpt> <outdir> --mode fp16|q4f16|fp32 [--layers 30] [--parts 3]
#                        [--causal] [--vector FxHxW] [--t 937.5]
import argparse, json, pathlib, sys, time
import numpy as np
import torch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import wanmods  # noqa: E402
from onnxg import save  # noqa: E402
from dit_onnx import build_part, build_ctx, rope_tables, t_freq, patchify, unpatchify  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt')
    ap.add_argument('out')
    ap.add_argument('--mode', default='fp16')
    ap.add_argument('--layers', type=int, default=30)
    ap.add_argument('--parts', type=int, default=3)
    ap.add_argument('--causal', action='store_true')
    ap.add_argument('--vector', default='3x16x24')
    ap.add_argument('--t', type=float, default=937.5)
    ap.add_argument('--prompt', default=None, help='a t5ref .npz to take the context from')
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model, extra, missing = wanmods.load_dit(args.ckpt)
    print('extra keys', extra[:6], len(extra), 'missing', missing[:6], flush=True)
    sd = {k: v for k, v in model.state_dict().items() if not k.startswith('blocks.') or int(k.split('.')[1]) < args.layers}
    per = (args.layers + args.parts - 1) // args.parts
    groups = [list(range(i, min(i + per, args.layers))) for i in range(0, args.layers, per)]
    manifest = {'mode': args.mode, 'layers': args.layers, 'groups': groups, 'causal': args.causal, 'files': {}}
    t0 = time.time()
    bits = 8 if args.mode.startswith('q8') else 4
    g = build_ctx(sd, mode=args.mode, bits=bits)
    p, d = save(g.model(), out / 'ctx.onnx')
    manifest['files']['ctx'] = ['ctx.onnx', 'ctx.onnx_data']
    print('ctx', f'{time.time() - t0:.0f}s', flush=True)
    for gi, blocks in enumerate(groups):
        g = build_part(sd, blocks, gi == 0, gi == len(groups) - 1, mode=args.mode, bits=bits, causal=args.causal, name=f'wan_part{gi}')
        save(g.model(), out / f'part{gi}.onnx')
        manifest['files'][f'part{gi}'] = [f'part{gi}.onnx', f'part{gi}.onnx_data']
        print('part', gi, blocks[0], '-', blocks[-1], f'{time.time() - t0:.0f}s', flush=True)
    # test vector: PyTorch fp32 on the CPU, the same truncated model
    F, H, Wd = map(int, args.vector.split('x'))
    rng = np.random.default_rng(7)
    z = rng.standard_normal((16, F, H, Wd)).astype(np.float32)
    if args.prompt:
        ctx = np.load(args.prompt)['fp32'].astype(np.float32)
    else:
        ctx = (rng.standard_normal((23, 4096)) * 0.1).astype(np.float32)
    seq = F * (H // 2) * (Wd // 2)
    ref_model = wanmods.WanModel(**dict(wanmods.DIT_CFG, num_layers=args.layers)).eval()
    ref_model.load_state_dict(sd)
    with torch.no_grad():
        ref = ref_model([torch.from_numpy(z)], torch.tensor([args.t]), [torch.from_numpy(ctx)], seq_len=seq)[0].numpy()
    padded = np.zeros((1, 512, 4096), np.float32)
    padded[0, :len(ctx)] = ctx
    cos, sin = rope_tables(F, H // 2, Wd // 2)
    vec = out / 'vector'
    vec.mkdir(exist_ok=True)
    arrays = {'context': padded, 'tokens': patchify(z)[None], 't_freq': t_freq(args.t), 'rope_cos': cos, 'rope_sin': sin,
              'flow_ref': patchify(ref)[None] * 0 + _flow_tokens(ref), 'latent_ref': ref}
    meta = {}
    for k, a in arrays.items():
        a = np.ascontiguousarray(a.astype(np.float32))
        a.tofile(vec / f'{k}.f32')
        meta[k] = list(a.shape)
    manifest['vector'] = {'shapes': meta, 'grid': [F, H // 2, Wd // 2], 't': args.t}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=1))
    print('done', f'{time.time() - t0:.0f}s')


def _flow_tokens(lat):
    """flow [16, F, H, W] → tokens [1, S, 64] in the head's (kh, kw, c) order."""
    c, f, h, w = lat.shape
    t = lat.reshape(c, f, h // 2, 2, w // 2, 2).transpose(1, 2, 4, 3, 5, 0)
    return t.reshape(1, f * (h // 2) * (w // 2), 64)


if __name__ == '__main__':
    main()
