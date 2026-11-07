# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# The Wan 2.1 1.3B DiT as ONNX graphs for ONNX Runtime Web (WebGPU), built op by op:
#   ctx      text features [1, 512, 4096] → cross-attention K and V of every block (once per prompt)
#   part_i   a run of blocks; the first also embeds patches and the timestep, the last
#            also applies the head. Tokens in, flow out: [1, S, 64] (patchify/unpatchify in JS).
# The residual stream stays fp32; linear layers run in fp16 (MatMul) or as MatMulNBits.
# Causal (Self-Forcing style) parts also take past keys/values and return the chunk's own.
import numpy as np
from onnx import TensorProto
from onnxg import Graph, MS, save

F32, F16, I64 = TensorProto.FLOAT, TensorProto.FLOAT16, TensorProto.INT64
DIM, HEADS, FFN, LAYERS = 1536, 12, 8960, 30


def W(sd, k):
    return sd[k].float().numpy() if hasattr(sd[k], 'float') else np.asarray(sd[k], np.float32)


class DitBuilder:
    def __init__(self, sd, mode='fp16', bits=4, block=32):
        self.sd, self.mode, self.bits, self.block = sd, mode, bits, block
        self.act = F32 if mode == 'fp32' else F16
        self.np_act = np.float32 if mode == 'fp32' else np.float16

    def lin(self, g, x, prefix, bias=True, force=None):
        import os
        f32 = [t for t in os.environ.get('WAN_F32_LAYERS', '').split(',') if t]
        if force is None and self.act == F16 and any(prefix.endswith(t) for t in f32):
            y = g.linear(g.op('Cast', [x], to=F32), W(self.sd, prefix + '.weight'), W(self.sd, prefix + '.bias') if bias else None,
                         prefix=prefix, mode='fp32')
            return g.op('Cast', [y], to=F16)
        mode = force or ('fp32' if self.mode == 'fp32' else ('nbits' if self.mode.startswith('q') else 'fp16'))
        return g.linear(x, W(self.sd, prefix + '.weight'), W(self.sd, prefix + '.bias') if bias else None, prefix=prefix,
                        mode=mode, bits=self.bits, block=self.block, act_dtype='float32' if self.mode == 'fp32' else 'float16')

    def to_act(self, g, x):
        return x if self.act == F32 else g.op('Cast', [x], to=self.act)

    def to_f32(self, g, x):
        return x if self.act == F32 else g.op('Cast', [x], to=F32)

    def layernorm(self, g, x, prefix=None):
        if prefix:
            w, b = W(self.sd, prefix + '.weight'), W(self.sd, prefix + '.bias')
        else:
            w, b = np.ones(DIM, np.float32), np.zeros(DIM, np.float32)
        return g.op('LayerNormalization', [x, g.const(w, 'ln_w'), g.const(b, 'ln_b')], axis=-1, epsilon=1e-6)

    def rmsnorm(self, g, x, prefix):
        return g.op('SimplifiedLayerNormalization', [x, g.init(prefix + '.weight', W(self.sd, prefix + '.weight').astype(self.np_act))],
                    axis=-1, epsilon=1e-6)

    def modulate(self, g, x, shift, scale):
        # x * (1 + scale) + shift, fp32
        return g.op('Add', [g.op('Mul', [x, g.op('Add', [scale, g.const(np.float32(1.0), 'one')])]), shift])

    # ------------------------------------------------------------------ ctx
    def build_ctx(self):
        g = Graph('wan_ctx')
        c = g.input('context', F32, [1, 512, 4096])
        h = self.lin(g, self.to_act(g, c), 'text_embedding.0')
        h = g.op('FastGelu', [h], domain=MS)
        h = self.lin(g, h, 'text_embedding.2')
        layers = 1 + max(int(k.split('.')[1]) for k in self.sd if k.startswith('blocks.'))
        for i in range(layers):
            p = f'blocks.{i}.cross_attn'
            k = self.rmsnorm(g, self.lin(g, h, p + '.k'), p + '.norm_k')
            v = self.lin(g, h, p + '.v')
            g.op('Identity', [k], outputs=[f'ck_{i}'])
            g.op('Identity', [v], outputs=[f'cv_{i}'])
            g.output(f'ck_{i}', self.act, [1, 512, DIM])
            g.output(f'cv_{i}', self.act, [1, 512, DIM])
        return g

    def _time(self, g, t_freq):
        h = self.lin(g, t_freq, 'time_embedding.0', force='fp32')
        h = g.op('Mul', [h, g.op('Sigmoid', [h])])
        e = self.lin(g, h, 'time_embedding.2', force='fp32')
        p = g.op('Mul', [e, g.op('Sigmoid', [e])])
        e0 = self.lin(g, p, 'time_projection.1', force='fp32')
        e0 = g.op('Reshape', [e0, g.const(np.array([1, 6, DIM], np.int64), 'shape')])
        return e, e0


def build_part(sd, blocks, first, last, mode='fp16', causal=False, bits=4, block=32, name='wan_part'):
    b = DitBuilder(sd, mode, bits, block)
    g = Graph(name)
    act = b.act
    if first:
        tokens = g.input('tokens', F32, [1, 'S', 64])
        t_freq = g.input('t_freq', F32, [1, 256])
        pe_w = W(sd, 'patch_embedding.weight').reshape(DIM, 64)
        x = g.op('Add', [g.op('MatMul', [tokens, g.init('patch_embedding.w', np.ascontiguousarray(pe_w.T))]),
                         g.init('patch_embedding.bias', W(sd, 'patch_embedding.bias'))])
        e, e0 = b._time(g, t_freq)
        if not last:
            g.op('Identity', [e], outputs=['e']); g.output('e', F32, [1, DIM])
            g.op('Identity', [e0], outputs=['e0']); g.output('e0', F32, [1, 6, DIM])
    else:
        x = g.input('hidden', F32, [1, 'S', DIM])
        e0 = g.input('e0', F32, [1, 6, DIM])
        e = g.input('e', F32, [1, DIM]) if last else None
    cos = g.input('rope_cos', act, ['S', 64])
    sin = g.input('rope_sin', act, ['S', 64])
    pos = g.input('rope_pos', I64, [1, 'S'])
    for i in blocks:
        p = f'blocks.{i}'
        mod = g.op('Add', [g.init(p + '.modulation', W(sd, p + '.modulation')), e0])
        sh_msa, sc_msa, g_msa, sh_mlp, sc_mlp, g_mlp = g.op('Split', [mod, g.const(np.array([1] * 6, np.int64), 'split')], n_out=6, axis=1)
        # self-attention
        h = b.modulate(g, b.layernorm(g, x), sh_msa, sc_msa)
        h = b.to_act(g, h)
        q = b.rmsnorm(g, b.lin(g, h, p + '.self_attn.q'), p + '.self_attn.norm_q')
        k = b.rmsnorm(g, b.lin(g, h, p + '.self_attn.k'), p + '.self_attn.norm_k')
        v = b.lin(g, h, p + '.self_attn.v')
        q = g.op('RotaryEmbedding', [q, pos, cos, sin], domain=MS, interleaved=1, num_heads=HEADS)
        k = g.op('RotaryEmbedding', [k, pos, cos, sin], domain=MS, interleaved=1, num_heads=HEADS)
        if causal:
            g.op('Identity', [k], outputs=[f'nk_{i}']); g.output(f'nk_{i}', act, [1, 'S', DIM])
            g.op('Identity', [v], outputs=[f'nv_{i}']); g.output(f'nv_{i}', act, [1, 'S', DIM])
            pk = g.input(f'pk_{i}', act, [1, 'P', DIM])
            pv = g.input(f'pv_{i}', act, [1, 'P', DIM])
            k = g.op('Concat', [pk, k], axis=1)
            v = g.op('Concat', [pv, v], axis=1)
        a = g.op('MultiHeadAttention', [q, k, v], domain=MS, num_heads=HEADS)
        y = b.to_f32(g, b.lin(g, a, p + '.self_attn.o'))
        x = g.op('Add', [x, g.op('Mul', [y, g_msa])])
        # cross-attention (keys and values come precomputed from the ctx graph)
        h = b.to_act(g, b.layernorm(g, x, p + '.norm3'))
        q = b.rmsnorm(g, b.lin(g, h, p + '.cross_attn.q'), p + '.cross_attn.norm_q')
        ck = g.input(f'ck_{i}', act, [1, 512, DIM])
        cv = g.input(f'cv_{i}', act, [1, 512, DIM])
        a = g.op('MultiHeadAttention', [q, ck, cv], domain=MS, num_heads=HEADS)
        x = g.op('Add', [x, b.to_f32(g, b.lin(g, a, p + '.cross_attn.o'))])
        # feed-forward
        h = b.to_act(g, b.modulate(g, b.layernorm(g, x), sh_mlp, sc_mlp))
        h = g.op('FastGelu', [b.lin(g, h, p + '.ffn.0')], domain=MS)
        y = b.to_f32(g, b.lin(g, h, p + '.ffn.2'))
        x = g.op('Add', [x, g.op('Mul', [y, g_mlp])])
    if last:
        hm = g.op('Add', [g.init('head.modulation', W(sd, 'head.modulation')), g.op('Unsqueeze', [e, g.const(np.array([1], np.int64), 'ax')])])
        shift, scale = g.op('Split', [hm, g.const(np.array([1, 1], np.int64), 'split')], n_out=2, axis=1)
        h = b.modulate(g, b.layernorm(g, x), shift, scale)
        out = g.op('Add', [g.op('MatMul', [h, g.init('head.head.w', np.ascontiguousarray(W(sd, 'head.head.weight').T))]),
                           g.init('head.head.bias', W(sd, 'head.head.bias'))])
        g.op('Identity', [out], outputs=['flow']); g.output('flow', F32, [1, 'S', 64])
    else:
        g.op('Identity', [x], outputs=['hidden_out']); g.output('hidden_out', F32, [1, 'S', DIM])
    return g


def build_ctx(sd, mode='fp16', bits=4, block=32):
    return DitBuilder(sd, mode, bits, block).build_ctx()


# ---------------------------------------------------------------------- JS-side maths, in numpy
def rope_tables(f, h, w, start_frame=0):
    """cos, sin [f*h*w, 64] for a latent grid of f frames and h × w patches."""
    d = DIM // HEADS
    dims = [d - 4 * (d // 6), 2 * (d // 6), 2 * (d // 6)]  # 44, 42, 42

    def inv(n):
        return 1.0 / np.power(10000.0, np.arange(0, n, 2, dtype=np.float64) / n)
    a0 = np.outer(np.arange(start_frame, start_frame + f, dtype=np.float64), inv(dims[0]))  # [f, 22]
    a1 = np.outer(np.arange(h, dtype=np.float64), inv(dims[1]))  # [h, 21]
    a2 = np.outer(np.arange(w, dtype=np.float64), inv(dims[2]))  # [w, 21]
    ang = np.concatenate([
        np.broadcast_to(a0[:, None, None, :], (f, h, w, a0.shape[1])),
        np.broadcast_to(a1[None, :, None, :], (f, h, w, a1.shape[1])),
        np.broadcast_to(a2[None, None, :, :], (f, h, w, a2.shape[1]))], -1).reshape(f * h * w, 64)
    return np.cos(ang).astype(np.float32), np.sin(ang).astype(np.float32)


def t_freq(t):
    half = 128
    pos = np.float64(t)
    s = pos * np.power(10000.0, -np.arange(half, dtype=np.float64) / half)
    return np.concatenate([np.cos(s), np.sin(s)])[None].astype(np.float32)


def patchify(z):
    """z [16, F, H, W] → tokens [F*H/2*W/2, 64] in the patch embedding's order (c, kh, kw)."""
    c, f, h, w = z.shape
    t = z.reshape(c, f, h // 2, 2, w // 2, 2).transpose(1, 2, 4, 0, 3, 5)
    return np.ascontiguousarray(t.reshape(f * (h // 2) * (w // 2), 64))


def unpatchify(tok, f, h, w):
    """flow tokens [S, 64] in the head's order (kh, kw, c) → [16, F, H, W]."""
    t = tok.reshape(f, h // 2, w // 2, 2, 2, 16).transpose(5, 0, 1, 3, 2, 4)
    return np.ascontiguousarray(t.reshape(16, f, h, w))
