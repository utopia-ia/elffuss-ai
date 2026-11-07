# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# The official Wan 2.1 modules (fetched under tmp/ref), with flash attention
# replaced by PyTorch SDPA, plus loaders for the checkpoints we compare.
import math, pathlib, sys
import os as _os
WORK = pathlib.Path(_os.environ.get('WAN_WORK') or pathlib.Path(__file__).resolve().parents[2] / 'tmp')  # scratch: ref/, wan_base/, out/, onnx/
import numpy as np
import torch
import torch.nn.functional as F
DEVICE = _os.environ.get('WAN_DEVICE') or ('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')

HERE = pathlib.Path(__file__).resolve().parent
TMP = WORK
sys.path.insert(0, str(TMP / 'ref'))

import wan.modules.attention as _att  # noqa: E402
import wan.modules.model as _model  # noqa: E402
import wan.modules.vae as _vae  # noqa: E402


def empty_cache():
    mod = getattr(torch, DEVICE.split(':')[0], None)
    if mod is not None and hasattr(mod, 'empty_cache'):
        mod.empty_cache()


def sdpa_attention(q, k, v, q_lens=None, k_lens=None, dropout_p=0., softmax_scale=None, q_scale=None,
                   causal=False, window_size=(-1, -1), deterministic=False, dtype=torch.bfloat16, version=None):
    # q, k, v: [B, L, N, D]. No padding in our use (k_lens is the full length).
    out_dtype = q.dtype
    q, k, v = (t.transpose(1, 2) for t in (q, k, v))
    if q_scale is not None:
        q = q * q_scale
    # Attention one head at a time keeps the score matrix small.
    outs = []
    for h in range(q.shape[1]):
        outs.append(F.scaled_dot_product_attention(q[:, h:h + 1], k[:, h:h + 1], v[:, h:h + 1], is_causal=causal, scale=softmax_scale))
    x = torch.cat(outs, 1)
    return x.transpose(1, 2).contiguous().to(out_dtype)


_att.flash_attention = sdpa_attention
_model.flash_attention = sdpa_attention

DIT_CFG = dict(model_type='t2v', patch_size=(1, 2, 2), text_len=512, in_dim=16, dim=1536, ffn_dim=8960, freq_dim=256,
               text_dim=4096, out_dim=16, num_heads=12, num_layers=30, window_size=(-1, -1), qk_norm=True,
               cross_attn_norm=True, eps=1e-6)


def rope_apply_real(x, grid_sizes, freqs, start_frame=0):
    # Same as the official rope_apply (complex), without float64 (not every device has it).
    n, c = x.size(2), x.size(3) // 2
    fr = freqs.split([c - 2 * (c // 3), c // 3, c // 3], dim=1)
    out = []
    for i, (f, h, w) in enumerate(grid_sizes.tolist()):
        seq_len = f * h * w
        fi = torch.cat([
            fr[0][start_frame:start_frame + f].view(f, 1, 1, -1).expand(f, h, w, -1),
            fr[1][:h].view(1, h, 1, -1).expand(f, h, w, -1),
            fr[2][:w].view(1, 1, w, -1).expand(f, h, w, -1)], dim=-1).reshape(seq_len, 1, -1)
        cos, sin = fi.real.float().to(x.device), fi.imag.float().to(x.device)
        xi = x[i, :seq_len].float().reshape(seq_len, n, -1, 2)
        a, b = xi[..., 0], xi[..., 1]
        xo = torch.stack([a * cos - b * sin, a * sin + b * cos], -1).flatten(2)
        out.append(torch.cat([xo, x[i, seq_len:].float()]))
    return torch.stack(out).float()


_model.rope_apply = rope_apply_real


def _no_float64_sinusoid(dim, position):
    half = dim // 2
    position = position.cpu().to(torch.float64)
    sinusoid = torch.outer(position, torch.pow(10000, -torch.arange(half).to(position).div(half)))
    return torch.cat([torch.cos(sinusoid), torch.sin(sinusoid)], dim=1).float()


_model.sinusoidal_embedding_1d = lambda dim, position: _no_float64_sinusoid(dim, position).to(position.device)

class _Fp32Region:
    """torch.cuda.amp.autocast(dtype=float32) of the official code, on any device: autocast off inside."""
    def __init__(self, *a, enabled=True, dtype=None, **k):
        self.ctx = [torch.autocast(d, enabled=False) for d in ('cpu', DEVICE.split(':')[0]) if d] if dtype == torch.float32 else []
    def __enter__(self):
        for c in self.ctx: c.__enter__()
    def __exit__(self, *e):
        for c in reversed(self.ctx): c.__exit__(*e)
    def __call__(self, fn):
        return fn


class _Amp:
    autocast = _Fp32Region


_model.amp = _Amp

WanModel = _model.WanModel


def strip_prefix(sd):
    """Checkpoints carry their weights under various keys and prefixes; return the bare DiT state dict."""
    for key in ('generator_ema', 'generator', 'model', 'state_dict', 'net', 'ema'):
        if isinstance(sd, dict) and key in sd and isinstance(sd[key], dict):
            sd = sd[key]
            break
    out = {}
    for k, v in sd.items():
        if not torch.is_tensor(v):
            continue
        for p in ('model._fsdp_wrapped_module.', '_fsdp_wrapped_module.', 'module.', 'model.', 'net.', '_orig_mod.'):
            if k.startswith(p):
                k = k[len(p):]
        out[k] = v
    return out


def load_dit(path, dtype=torch.float32, device='cpu', strict=True):
    path = pathlib.Path(path)
    if path.suffix == '.safetensors':
        from safetensors.torch import load_file
        sd = load_file(str(path))
    else:
        sd = torch.load(str(path), map_location='cpu', weights_only=False, mmap=True)
    sd = strip_prefix(sd)
    if 'patch_embedding.weight' in sd and sd['patch_embedding.weight'].ndim == 2:
        sd['patch_embedding.weight'] = sd['patch_embedding.weight'].reshape(1536, 16, 1, 2, 2)
    with torch.device('meta'):
        model = WanModel(**DIT_CFG)
    known = set(model.state_dict().keys())
    extra = sorted(set(sd) - known)
    missing = sorted(known - set(sd))
    model.load_state_dict({k: v.to(dtype) for k, v in sd.items() if k in known}, strict=strict, assign=True)
    model.freqs = model.freqs  # complex buffer built on meta: rebuild on CPU
    d = 1536 // 12
    model.freqs = torch.cat([_model.rope_params(1024, d - 4 * (d // 6)), _model.rope_params(1024, 2 * (d // 6)),
                             _model.rope_params(1024, 2 * (d // 6))], dim=1)
    return model.to(device).eval().requires_grad_(False), extra, missing


VAE_MEAN = [-0.7571, -0.7089, -0.9113, 0.1075, -0.1745, 0.9653, -0.1517, 1.5508,
            0.4134, -0.0715, 0.5517, -0.3632, -0.1922, -0.9497, 0.2503, -0.2921]
VAE_STD = [2.8184, 1.4541, 2.3275, 2.6558, 1.2196, 1.7708, 2.6052, 2.0743,
           3.2687, 2.1526, 2.8652, 1.5579, 1.6382, 1.1253, 2.8251, 1.9160]


def load_vae(device='cpu', dtype=torch.float32):
    vae = _vae._video_vae(pretrained_path=str(TMP / 'wan_base' / 'Wan2.1_VAE.pth'), z_dim=16).eval().requires_grad_(False)
    return vae.to(device=device, dtype=dtype)


def vae_decode(vae, z):
    """z: [16, F, H, W] latent → video [3, T, H*8, W*8] in [-1, 1]."""
    dev, dt = next(vae.parameters()).device, next(vae.parameters()).dtype
    scale = [torch.tensor(VAE_MEAN, device=dev, dtype=dt), 1.0 / torch.tensor(VAE_STD, device=dev, dtype=dt)]
    with torch.no_grad():
        return vae.decode(z[None].to(dev, dt), scale).float().clamp(-1, 1)[0]


# The noise both sides draw: a counter-based generator any language can repeat.
# Every value comes from (seed, stream, index) through a 32-bit hash, then Box-Muller.
def _hash32(x):
    x = x.astype(np.uint32)
    x ^= x >> np.uint32(16); x *= np.uint32(0x7feb352d)
    x ^= x >> np.uint32(15); x *= np.uint32(0x846ca68b)
    x ^= x >> np.uint32(16)
    return x


def noise(seed, stream, n):
    """n standard normal float32 values for (seed, stream)."""
    with np.errstate(over='ignore'):
        base = _hash32(np.array([seed & 0xffffffff], np.uint32) ^ _hash32(np.array([(stream * 0x9e3779b9) & 0xffffffff], np.uint32)))[0]
        half = (n + 1) // 2
        i = np.arange(half, dtype=np.uint64)
        a = _hash32(((i * 2) & 0xffffffff).astype(np.uint32) ^ base)
        b = _hash32(((i * 2 + 1) & 0xffffffff).astype(np.uint32) ^ _hash32(np.array([base ^ 0x68e31da4], np.uint32))[0])
    u1 = (a.astype(np.float64) + 1.0) / 4294967296.0
    u2 = b.astype(np.float64) / 4294967296.0
    r = np.sqrt(-2.0 * np.log(u1))
    z = np.empty(half * 2, np.float64)
    z[0::2] = r * np.cos(2 * math.pi * u2)
    z[1::2] = r * np.sin(2 * math.pi * u2)
    return z[:n].astype(np.float32)
