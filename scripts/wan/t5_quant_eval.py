# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# How much does quantising UMT5-XXL change its output? Simulates in PyTorch exactly what
# the browser graph computes (block-quantised linear layers with fp32 activations, and
# the token embedding table quantised and gathered outside the graph), and compares every
# prompt's embedding with the fp32 reference and with the bf16 compute of the official pipeline.
import json, sys, time, pathlib
import os as _os
WORK = pathlib.Path(_os.environ.get('WAN_WORK') or pathlib.Path(__file__).resolve().parents[2] / 'tmp')  # scratch: ref/, wan_base/, out/, onnx/
import numpy as np
import torch

HERE = pathlib.Path(__file__).resolve().parent
TMP = WORK
sys.path.insert(0, str(TMP / 'ref'))
sys.path.insert(0, str(HERE))
from wan.modules.t5 import umt5_xxl  # noqa: E402
from onnxg import quantize_blocks  # noqa: E402

CKPT = TMP / 'wan_base' / 'models_t5_umt5-xxl-enc-bf16.pth'
REF = TMP / 'out' / 't5ref'


def embed_q8_rows(table):
    s = np.abs(table).max(1, keepdims=True) / 127.0
    s = np.maximum(s, 1e-12).astype(np.float16).astype(np.float32)
    q = np.clip(np.round(table / s), -127, 127)
    return (q * s).astype(np.float32)


def embed_q4_blocks(table, block=32):
    out = np.empty_like(table)
    step = 16384
    for i in range(0, table.shape[0], step):
        out[i:i + step] = quantize_blocks(table[i:i + step], bits=4, block=block)[3]
    return out


def metrics(a, b):
    cos = (a * b).sum(-1) / (np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1) + 1e-12)
    rel = np.linalg.norm(a - b) / np.linalg.norm(a)
    return float(cos.min()), float(cos.mean()), float(rel)


def main():
    configs = sys.argv[1:] or ['emb8', 'emb4', 'l8b32+emb8', 'l4b32+emb8', 'l4b32+emb4', 'l4b64+emb8', 'l4b128+emb8']
    prompts = json.loads((HERE / 'prompts.json').read_text())
    refs = {p['id']: dict(np.load(REF / f"{p['id']}.npz")) for p in prompts}
    sd = torch.load(CKPT, map_location='cpu', weights_only=True)
    model = umt5_xxl(encoder_only=True, return_tokenizer=False, dtype=torch.float32, device='cpu').eval().requires_grad_(False)
    model.load_state_dict({k: v.float() for k, v in sd.items()}, strict=True)
    torch.set_num_threads(12)
    linear_names = [n for n, m in model.named_modules() if isinstance(m, torch.nn.Linear)]
    orig = {n: sd[n + '.weight'] for n in linear_names}
    emb_orig = sd['token_embedding.weight'].float().numpy()
    del sd
    cache = {}
    results = {}
    # the bf16 floor
    floor = [metrics(refs[p['id']]['fp32'], refs[p['id']]['bf16']) for p in prompts]
    results['bf16-compute'] = floor
    print('bf16-compute', [f'{m[1]:.4f}/{m[2]:.4f}' for m in floor], flush=True)
    for cfg in configs:
        t0 = time.time()
        parts = dict(x.split(':') if ':' in x else (x[:1], x) for x in [])  # unused
        lay = next((x for x in cfg.split('+') if x.startswith('l')), None)
        emb = next((x for x in cfg.split('+') if x.startswith('emb')), None)
        # layers
        for n in linear_names:
            mod = dict(model.named_modules())[n]
            only = lay.split(':')[1].split('|') if lay and ':' in lay else None
            hi = lay.split('~')[1].split('|') if lay and '~' in lay else []
            if lay is None or (only and not any(o in n for o in only)):
                w = orig[n].float()
            else:
                spec = lay.split(':')[0].split('~')[0]
                bits, block = int(spec[1]), int(spec.split('b')[1])
                if any(h in n for h in hi):
                    bits = 8
                key = (n, bits, block)
                if key not in cache:
                    cache[key] = torch.from_numpy(quantize_blocks(orig[n].float().numpy(), bits=bits, block=block)[3])
                w = cache[key]
            mod.weight.data = w
        if emb == 'emb8':
            e = cache.setdefault('emb8', torch.from_numpy(embed_q8_rows(emb_orig)))
        elif emb == 'emb8b32':
            e = cache.setdefault('emb8b32', torch.from_numpy(np.concatenate([quantize_blocks(emb_orig[i:i + 16384], bits=8, block=32)[3] for i in range(0, emb_orig.shape[0], 16384)])))
        elif emb == 'emb4':
            e = cache.setdefault('emb4', torch.from_numpy(embed_q4_blocks(emb_orig)))
        else:
            e = torch.from_numpy(emb_orig)
        model.token_embedding.weight.data = e
        res = []
        for p in prompts:
            ids = torch.from_numpy(refs[p['id']]['ids'].astype(np.int64))[None]
            with torch.no_grad():
                out = model(ids, torch.ones_like(ids))[0].numpy()
            np.save(TMP / 'out' / 't5ref' / f"{p['id']}.{cfg}.npy", out)
            res.append(metrics(refs[p['id']]['fp32'], out))
        results[cfg] = res
        print(cfg, f'{time.time() - t0:.0f}s', [f'{m[1]:.4f}/{m[2]:.4f}' for m in res], 'worst cos', min(m[0] for m in res), flush=True)
        # free per-layer caches of configs we will not reuse
        pass
    (TMP / 'out' / 't5_quant_eval.json').write_text(json.dumps(results, indent=1))


if __name__ == '__main__':
    main()
