# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# UMT5-XXL encoder as ONNX shards for ONNX Runtime Web: each shard is a run of layers
# (hidden [1, L, 4096] fp32 in and out, plus the relative-position buckets [L, L]), linear
# layers as MatMulNBits with fp32 activations. The token embedding is not in the graphs:
# it is a table of int8 rows with one fp16 scale each, read row by row in JavaScript.
#   python export_t5.py <outdir> [--shards 4] [--bits 4] [--block 32] [--hi8 ffn.fc2|attn.o] [--check]
import argparse, json, pathlib, sys, time
import os as _os
WORK = pathlib.Path(_os.environ.get('WAN_WORK') or pathlib.Path(__file__).resolve().parents[2] / 'tmp')  # scratch: ref/, wan_base/, out/, onnx/
import numpy as np, torch
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(WORK / 'ref'))
from onnx import TensorProto
from onnxg import Graph, MS, save

CKPT = WORK / 'wan_base' / 'models_t5_umt5-xxl-enc-bf16.pth'
F32, I64 = TensorProto.FLOAT, TensorProto.INT64


def build_shard(sd, layers, last, bits, block, hi8):
    g = Graph('umt5_shard')
    x = g.input('hidden', F32, [1, 'L', 4096])
    buckets = g.input('buckets', I64, ['L', 'L'])
    def lin(h, name):
        b = 8 if any(t in name for t in hi8) else bits
        return g.linear(h, sd[name + '.weight'].float().numpy(), None, prefix=name, mode='nbits', bits=b, block=block, act_dtype='float32')
    def norm(h, name):
        return g.op('SimplifiedLayerNormalization', [h, g.init(name, sd[name].float().numpy())], axis=-1, epsilon=1e-6)
    for i in layers:
        p = f'blocks.{i}'
        h = norm(x, p + '.norm1.weight')
        q, k, v = (lin(h, f'{p}.attn.{n}') for n in 'qkv')
        bias = g.op('Gather', [g.init(p + '.pos_embedding.embedding.weight', sd[p + '.pos_embedding.embedding.weight'].float().numpy()), buckets])  # [L, L, 64]
        bias = g.op('Unsqueeze', [g.op('Transpose', [bias], perm=[2, 0, 1]), g.const(np.array([0], np.int64), 'ax')])
        a = g.op('MultiHeadAttention', [q, k, v, '', '', bias], domain=MS, num_heads=64, scale=1.0)
        x = g.op('Add', [x, lin(a, p + '.attn.o')])
        h = norm(x, p + '.norm2.weight')
        gate = g.op('FastGelu', [lin(h, p + '.ffn.gate.0')], domain=MS)
        f = g.op('Mul', [lin(h, p + '.ffn.fc1'), gate])
        x = g.op('Add', [x, lin(f, p + '.ffn.fc2')])
    if last:
        x = norm(x, 'norm.weight')
    g.op('Identity', [x], outputs=['hidden_out'])
    g.output('hidden_out', F32, [1, 'L', 4096])
    return g


def buckets(L, num_buckets=32, max_dist=128):
    rel = np.arange(L)[None, :] - np.arange(L)[:, None]
    nb = num_buckets // 2
    out = (rel > 0).astype(np.int64) * nb
    rel = np.abs(rel)
    max_exact = nb // 2
    large = max_exact + (np.log(np.maximum(rel, 1) / max_exact) / np.log(max_dist / max_exact) * (nb - max_exact)).astype(np.int64)
    large = np.minimum(large, nb - 1)
    return out + np.where(rel < max_exact, rel, large)


def embed_table(emb, block=32):
    """4-bit rows, blocks of 32 with an fp16 scale and a 4-bit zero each. Per row: 2048 bytes of
    values (low nibble first), 128 fp16 scales, 64 bytes of zeros (low nibble first)."""
    from onnxg import quantize_blocks
    V, D = emb.shape
    nb = D // block
    rows = np.empty((V, D // 2 + nb * 2 + nb // 2), np.uint8)
    deq = np.empty_like(emb)
    for i in range(0, V, 8192):
        packed, scale, zp, d = quantize_blocks(emb[i:i + 8192], bits=4, block=block)
        n = packed.shape[0]
        sc16 = scale.astype(np.float16)
        d = ((((packed[..., None] >> np.array([0, 4], np.uint8)) & 15).reshape(n, nb, block).astype(np.float32) - zp[..., None]) * sc16.astype(np.float32)[..., None]).reshape(n, D)
        rows[i:i + n, :D // 2] = packed.reshape(n, -1)
        rows[i:i + n, D // 2:D // 2 + nb * 2] = sc16.view(np.uint8).reshape(n, -1)
        rows[i:i + n, D // 2 + nb * 2:] = (zp[:, 0::2] | (zp[:, 1::2] << 4)).astype(np.uint8)
        deq[i:i + n] = d
    return rows, deq


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out'); ap.add_argument('--shards', type=int, default=4)
    ap.add_argument('--bits', type=int, default=4); ap.add_argument('--block', type=int, default=32)
    ap.add_argument('--hi8', default=''); ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    hi8 = [t for t in a.hi8.split('|') if t]
    sd = torch.load(CKPT, map_location='cpu', weights_only=True)
    per = 24 // a.shards
    t0 = time.time()
    for s in range(a.shards):
        layers = list(range(s * per, (s + 1) * per))
        save(build_shard(sd, layers, s == a.shards - 1, a.bits, a.block, hi8).model(), out / f'encoder_{s}.onnx')
        print('shard', s, f'{time.time() - t0:.0f}s', flush=True)
    rows, deq = embed_table(sd['token_embedding.weight'].float().numpy())
    rows.tofile(out / 'embed_q4.bin')
    (out / 'manifest.json').write_text(json.dumps({'shards': a.shards, 'bits': a.bits, 'block': a.block, 'hi8': hi8, 'vocab': int(rows.shape[0]), 'rowBytes': int(rows.shape[1])}))
    if a.check:
        import onnxruntime as ort
        prompts = json.loads((HERE / 'prompts.json').read_text())
        sess = [ort.InferenceSession(str(out / f'encoder_{s}.onnx'), providers=['CPUExecutionProvider']) for s in range(a.shards)]
        for p in prompts:
            ref = np.load(WORK / 'out' / 't5ref' / f"{p['id']}.npz")
            ids = ref['ids']
            h = deq[ids][None]
            bk = buckets(len(ids))
            for s in sess:
                h = s.run(None, {'hidden': h, 'buckets': bk})[0]
            np.save(out / f"check_{p['id']}.npy", h[0])
            r = ref['fp32']
            print(p['id'], 'rel L2 vs fp32', f'{np.linalg.norm(h[0] - r) / np.linalg.norm(r):.4f}', flush=True)


if __name__ == '__main__':
    main()
