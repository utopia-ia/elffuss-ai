# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Wan 2.1 VACE 1.3B for ONNX Runtime Web: the base transformer (the T2V one, rCM weights) with
# the VACE module woven in. VACE adds 15 blocks that read a "control" stream (known frames and
# a mask, as latents) and give a hint after base blocks 0, 2, … 28. VACE block k only needs the
# control state of block k-1 (and, for k = 0, the patch-embedded video), so it runs just before
# the base block that takes its hint, and the parts stay the T2V ones:
#   vctx     text features → the cross-attention K and V of the 15 VACE blocks (once per prompt)
#   vpart_i  base blocks of part i with their VACE blocks; the first also embeds the control
#            tokens, and every part passes the control state on (`chid` → `chid_out`)
# The base weights are byte for byte those of the T2V graphs, so graft() points them at the
# published part*.onnx_data and only the VACE weights are new.
import hashlib
import numpy as np
import onnx
from onnx import TensorProto
from onnxg import Graph, MS
from dit_onnx import DitBuilder, W, DIM, HEADS

F32, F16, I64 = TensorProto.FLOAT, TensorProto.FLOAT16, TensorProto.INT64
VACE_LAYERS = list(range(0, 30, 2))   # base block that takes VACE hint k is VACE_LAYERS[k]
CONTROL_CHANNELS = 96                 # 16 inactive + 16 reactive + 64 mask
CONTROL_VALUES = CONTROL_CHANNELS * 4


def vace_state_dict(dsd):
    """Diffusers WanVACETransformer3DModel state dict → the VACE module in Wan's own names."""
    out = {}
    ren = [('.proj_in.', '.before_proj.'), ('.proj_out.', '.after_proj.'), ('.attn1.to_out.0.', '.self_attn.o.'),
           ('.attn2.to_out.0.', '.cross_attn.o.'), ('.attn1.to_', '.self_attn.'), ('.attn2.to_', '.cross_attn.'),
           ('.attn1.', '.self_attn.'), ('.attn2.', '.cross_attn.'), ('.norm2.', '.norm3.'),
           ('.ffn.net.0.proj.', '.ffn.0.'), ('.ffn.net.2.', '.ffn.2.')]
    for k, v in dsd.items():
        if k.startswith('vace_patch_embedding.'):
            out[k] = v
        elif k.startswith('vace_blocks.'):
            n = k
            if n.endswith('.scale_shift_table'):
                n = n.replace('.scale_shift_table', '.modulation')
            for a, b in ren:
                n = n.replace(a, b)
            out[n] = v
    return out


def wan_block(g, b, x, e0, p, ck, cv, cos, sin, pos):
    """One Wan block (the T2V one, op for op), residual stream x fp32."""
    sd = b.sd
    mod = g.op('Add', [g.init(p + '.modulation', W(sd, p + '.modulation')), e0])
    sh_msa, sc_msa, g_msa, sh_mlp, sc_mlp, g_mlp = g.op('Split', [mod, g.const(np.array([1] * 6, np.int64), 'split')], n_out=6, axis=1)
    h = b.to_act(g, b.modulate(g, b.layernorm(g, x), sh_msa, sc_msa))
    q = b.rmsnorm(g, b.lin(g, h, p + '.self_attn.q'), p + '.self_attn.norm_q')
    k = b.rmsnorm(g, b.lin(g, h, p + '.self_attn.k'), p + '.self_attn.norm_k')
    v = b.lin(g, h, p + '.self_attn.v')
    q = g.op('RotaryEmbedding', [q, pos, cos, sin], domain=MS, interleaved=1, num_heads=HEADS)
    k = g.op('RotaryEmbedding', [k, pos, cos, sin], domain=MS, interleaved=1, num_heads=HEADS)
    a = g.op('MultiHeadAttention', [q, k, v], domain=MS, num_heads=HEADS)
    x = g.op('Add', [x, g.op('Mul', [b.to_f32(g, b.lin(g, a, p + '.self_attn.o')), g_msa])])
    h = b.to_act(g, b.layernorm(g, x, p + '.norm3'))
    q = b.rmsnorm(g, b.lin(g, h, p + '.cross_attn.q'), p + '.cross_attn.norm_q')
    a = g.op('MultiHeadAttention', [q, ck, cv], domain=MS, num_heads=HEADS)
    x = g.op('Add', [x, b.to_f32(g, b.lin(g, a, p + '.cross_attn.o'))])
    h = b.to_act(g, b.modulate(g, b.layernorm(g, x), sh_mlp, sc_mlp))
    h = g.op('FastGelu', [b.lin(g, h, p + '.ffn.0')], domain=MS)
    return g.op('Add', [x, g.op('Mul', [b.to_f32(g, b.lin(g, h, p + '.ffn.2')), g_mlp])])


def build_vace_part(base_sd, vace_sd, blocks, first, last, mode='q8f16', bits=8, vbits=8, block=32, name='wan_vpart'):
    """Base blocks `blocks` with the VACE blocks whose hints they take."""
    b = DitBuilder(base_sd, mode, bits, block)
    vb = DitBuilder(vace_sd, mode, vbits, block)
    g = Graph(name)
    act = b.act
    if first:
        tokens = g.input('tokens', F32, [1, 'S', 64])
        t_freq = g.input('t_freq', F32, [1, 256])
        control = g.input('control', F32, [1, 'S', CONTROL_VALUES])
        pe_w = W(base_sd, 'patch_embedding.weight').reshape(DIM, 64)
        x = g.op('Add', [g.op('MatMul', [tokens, g.init('patch_embedding.w', np.ascontiguousarray(pe_w.T))]),
                         g.init('patch_embedding.bias', W(base_sd, 'patch_embedding.bias'))])
        vw = W(vace_sd, 'vace_patch_embedding.weight').reshape(DIM, CONTROL_VALUES)
        c = g.op('Add', [g.op('MatMul', [control, g.init('vace_patch_embedding.w', np.ascontiguousarray(vw.T))]),
                         g.init('vace_patch_embedding.bias', W(vace_sd, 'vace_patch_embedding.bias'))])
        x0 = x
        e, e0 = b._time(g, t_freq)
        if not last:
            g.op('Identity', [e], outputs=['e']); g.output('e', F32, [1, DIM])
            g.op('Identity', [e0], outputs=['e0']); g.output('e0', F32, [1, 6, DIM])
    else:
        x = g.input('hidden', F32, [1, 'S', DIM])
        c = g.input('chid', F32, [1, 'S', DIM])
        e0 = g.input('e0', F32, [1, 6, DIM])
        e = g.input('e', F32, [1, DIM]) if last else None
        x0 = None
    cos = g.input('rope_cos', act, ['S', 64])
    sin = g.input('rope_sin', act, ['S', 64])
    pos = g.input('rope_pos', I64, [1, 'S'])
    for i in blocks:
        if i in VACE_LAYERS:
            k = VACE_LAYERS.index(i)
            p = f'vace_blocks.{k}'
            if k == 0:
                assert x0 is not None, 'VACE block 0 must be in the first part'
                c = g.op('Add', [b.to_f32(g, vb.lin(g, b.to_act(g, c), p + '.before_proj')), x0])
            vck = g.input(f'vck_{k}', act, [1, 512, DIM])
            vcv = g.input(f'vcv_{k}', act, [1, 512, DIM])
            c = wan_block(g, vb, c, e0, p, vck, vcv, cos, sin, pos)
            hint = b.to_f32(g, vb.lin(g, b.to_act(g, c), p + '.after_proj'))
        ck = g.input(f'ck_{i}', act, [1, 512, DIM])
        cv = g.input(f'cv_{i}', act, [1, 512, DIM])
        x = wan_block(g, b, x, e0, f'blocks.{i}', ck, cv, cos, sin, pos)
        if i in VACE_LAYERS:
            x = g.op('Add', [x, hint])
    if last:
        hm = g.op('Add', [g.init('head.modulation', W(base_sd, 'head.modulation')), g.op('Unsqueeze', [e, g.const(np.array([1], np.int64), 'ax')])])
        shift, scale = g.op('Split', [hm, g.const(np.array([1, 1], np.int64), 'split')], n_out=2, axis=1)
        h = b.modulate(g, b.layernorm(g, x), shift, scale)
        out = g.op('Add', [g.op('MatMul', [h, g.init('head.head.w', np.ascontiguousarray(W(base_sd, 'head.head.weight').T))]),
                           g.init('head.head.bias', W(base_sd, 'head.head.bias'))])
        g.op('Identity', [out], outputs=['flow']); g.output('flow', F32, [1, 'S', 64])
    else:
        g.op('Identity', [x], outputs=['hidden_out']); g.output('hidden_out', F32, [1, 'S', DIM])
        g.op('Identity', [c], outputs=['chid_out']); g.output('chid_out', F32, [1, 'S', DIM])
    return g


def build_vctx(base_sd, vace_sd, mode='q8f16', bits=8, vbits=8, block=32, count=None):
    """Text features → K and V of the VACE blocks' cross-attention (the text embedding is the base one)."""
    b = DitBuilder(base_sd, mode, bits, block)
    vb = DitBuilder(vace_sd, mode, vbits, block)
    g = Graph('wan_vctx')
    c = g.input('context', F32, [1, 512, 4096])
    h = b.lin(g, b.to_act(g, c), 'text_embedding.0')
    h = g.op('FastGelu', [h], domain=MS)
    h = b.lin(g, h, 'text_embedding.2')
    for k in range(count or len(VACE_LAYERS)):
        p = f'vace_blocks.{k}.cross_attn'
        kk = vb.rmsnorm(g, vb.lin(g, h, p + '.k'), p + '.norm_k')
        v = vb.lin(g, h, p + '.v')
        g.op('Identity', [kk], outputs=[f'vck_{k}']); g.output(f'vck_{k}', b.act, [1, 512, DIM])
        g.op('Identity', [v], outputs=[f'vcv_{k}']); g.output(f'vcv_{k}', b.act, [1, 512, DIM])
    return g


# ---------------------------------------------------------------------- reuse of published weights
def _ext(t):
    return {e.key: e.value for e in t.external_data}


def graft(model, data_name, olds):
    """Store `model`'s large initialisers: those byte-identical to a tensor of an old graph
    (olds: [(graph path, data path, location name)]) point into that old data file; the rest go
    to `data_name`. Returns (new bytes, reused bytes). The model's initialisers must hold raw data."""
    index = {}
    for gpath, dpath, loc in olds:
        m = onnx.load(str(gpath), load_external_data=False)
        with open(dpath, 'rb') as f:
            for t in m.graph.initializer:
                if t.data_location != TensorProto.EXTERNAL:
                    continue
                e = _ext(t)
                f.seek(int(e.get('offset', 0)))
                raw = f.read(int(e['length']))
                index.setdefault((t.data_type, tuple(t.dims), hashlib.sha256(raw).hexdigest()), (loc, int(e.get('offset', 0)), int(e['length'])))
    new, reused = bytearray(), 0
    for t in model.graph.initializer:
        raw = t.raw_data if t.HasField('raw_data') else onnx.numpy_helper.to_array(t).tobytes()
        if len(raw) <= 1024:
            continue
        key = (t.data_type, tuple(t.dims), hashlib.sha256(raw).hexdigest())
        if key in index:
            loc, off, n = index[key]
            reused += n
        else:
            pad = (-len(new)) % 64
            new += b'\0' * pad
            loc, off, n = data_name, len(new), len(raw)
            new += raw
        for fld in ('raw_data', 'float_data', 'int32_data', 'int64_data', 'double_data', 'uint64_data'):
            t.ClearField(fld)
        del t.external_data[:]
        t.data_location = TensorProto.EXTERNAL
        for kk, vv in (('location', loc), ('offset', str(off)), ('length', str(n))):
            e = t.external_data.add(); e.key, e.value = kk, vv
    return bytes(new), reused


# ---------------------------------------------------------------------- the tiny encoder, streaming
def tae_encoder_stream(tae, mean, std):
    """lighttaew2_1's encoder over one latent's worth of frames (4) with the memory of the last
    chunk: x [4, 3, H, W] in [0, 1] and mem_0..mem_8 → z [1, 16, H/8, W/8] in the DiT's space
    (normalised) and the memories. Matches TAEHV.encode_video (parallel) chunk by chunk."""
    import torch
    import torch.nn as nn
    from taehv import MemBlock, TPool

    class Enc(nn.Module):
        def __init__(self):
            super().__init__()
            self.blocks = tae.encoder
            self.register_buffer('mean', torch.tensor(mean, dtype=torch.float32).view(1, 16, 1, 1))
            self.register_buffer('std', torch.tensor(std, dtype=torch.float32).view(1, 16, 1, 1))

        def forward(self, x, *mems):
            new, k = [], 0
            for blk in self.blocks:
                if isinstance(blk, MemBlock):
                    past = torch.cat([mems[k], x[:-1]], 0)
                    new.append(x[-1:])
                    x = blk(x, past)
                    k += 1
                elif isinstance(blk, TPool):
                    x = blk(x)
                else:
                    x = blk(x)
            return ((x - self.mean) / self.std, *new)
    return Enc().eval()


def tae_encoder_mem_shapes(H, W):
    """Memories of the encoder's MemBlocks for frames of H × W: 3 at /2 (2 frames per chunk), 3 at /4, 3 at /8."""
    return [(1, 64, H // 2, W // 2)] * 3 + [(1, 64, H // 4, W // 4)] * 3 + [(1, 64, H // 8, W // 8)] * 3
