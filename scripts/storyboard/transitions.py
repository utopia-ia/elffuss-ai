# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# The clip between two keyframes with Wan 2.1 VACE 1.3B: the known frames (first, last, or a few
# of the previous clip) go in as VACE context with a mask, the rest is generated from the prompt.
# The base transformer can be swapped for the rCM few-step one (the VACE blocks stay), so the
# sampler is the same 4-step one the browser already runs for text-to-video.
#   base 'rcm': rCM weights for the 30 base blocks, 4 steps, no CFG
#   base 'vace': the original VACE weights, UniPC, 25 steps, CFG 5 (the slow reference)
import math, os, pathlib, sys, time
import numpy as np
import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import DEVICE, TAEHV_DIR, snapshot, hub_file, empty_cache  # noqa: E402

DT = {'bf16': torch.bfloat16, 'fp16': torch.float16, 'fp32': torch.float32}[os.environ.get('SB_DTYPE', 'bf16')]
# SB_FAKEQ="8,4": weights through the browser export's block quantizer (base bits, VACE bits)
FAKEQ = tuple(int(b) for b in os.environ['SB_FAKEQ'].split(',')) if os.environ.get('SB_FAKEQ') else None
_m = {}
NEG = ('Bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, static, overall gray, '
       'worst quality, low quality, JPEG compression residue, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn '
       'faces, deformed, disfigured, misshapen limbs, fused fingers, still picture, messy background, three legs, many people in '
       'the background, walking backwards')


def strip_prefix(sd):
    for key in ('generator_ema', 'generator', 'model', 'state_dict', 'net', 'ema'):
        if isinstance(sd, dict) and key in sd and isinstance(sd[key], dict):
            sd = sd[key]; break
    out = {}
    for k, v in sd.items():
        if not torch.is_tensor(v):
            continue
        for p in ('model._fsdp_wrapped_module.', '_fsdp_wrapped_module.', 'module.', 'model.', 'net.', '_orig_mod.'):
            if k.startswith(p):
                k = k[len(p):]
        out[k] = v
    return out


def transformer(base):
    if _m.get('base') != base:
        _m.pop('tr', None); empty_cache()
        from diffusers import WanVACETransformer3DModel
        snap = snapshot('Wan-AI/Wan2.1-VACE-1.3B-diffusers')
        tr = WanVACETransformer3DModel.from_pretrained(snap / 'transformer', torch_dtype=torch.float32)
        if base == 'rcm':
            from diffusers.loaders.single_file_utils import convert_wan_transformer_to_diffusers
            sd = strip_prefix(torch.load(hub_file('worstcoder/rcm-Wan', 'rCM_Wan2.1_T2V_1.3B_480p.pt'), map_location='cpu', weights_only=False, mmap=True))
            if 'patch_embedding.weight' in sd and sd['patch_embedding.weight'].ndim == 2:
                sd['patch_embedding.weight'] = sd['patch_embedding.weight'].reshape(1536, 16, 1, 2, 2)
            sd = convert_wan_transformer_to_diffusers(sd)
            own = tr.state_dict()
            bad = [k for k in sd if k not in own or own[k].shape != sd[k].shape]
            r = tr.load_state_dict({k: v.float() for k, v in sd.items() if k not in bad}, strict=False)
            missing = [k for k in r.missing_keys if not k.startswith('vace_')]
            print('rcm swap:', len(sd) - len(bad), 'tensors in; not matching', bad[:4], '; base keys left from VACE', missing[:6], flush=True)
            assert not missing, missing
        if FAKEQ:
            fake_quantize(tr, *FAKEQ)
        _m.update(tr=tr.to(DEVICE, DT).eval(), base=base)
    return _m['tr']


def fake_quantize(tr, bits, vbits):
    """Replace each linear weight the browser quantizes by its dequantized MatMulNBits value
    (block 32, the exporter's own quantizer): base blocks and the text embedding in `bits`,
    the VACE blocks in `vbits`. Time embeddings, patch embeddings and the head stay as they are."""
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'wan'))
    from onnxg import quantize_blocks
    n = 0
    for name, mod in tr.named_modules():
        if not isinstance(mod, torch.nn.Linear):
            continue
        b = vbits if name.startswith('vace_blocks.') else bits if name.startswith(('blocks.', 'condition_embedder.text_embedder.')) else None
        if b is None:
            continue
        mod.weight.data = torch.from_numpy(quantize_blocks(mod.weight.data.float().numpy(), bits=b, block=32)[3])
        n += 1
    print(f'fake-quantized {n} linear layers: base {bits} bits, VACE {vbits} bits', flush=True)


def vae():
    if 'vae' not in _m:
        from diffusers import AutoencoderKLWan
        _m['vae'] = AutoencoderKLWan.from_pretrained(snapshot('Wan-AI/Wan2.1-VACE-1.3B-diffusers') / 'vae', torch_dtype=torch.float32).to(DEVICE).eval()
    return _m['vae']


def tae(name='lighttaew2_1'):
    if 'tae' not in _m:
        sys.path.insert(0, str(TAEHV_DIR))
        from taehv import TAEHV
        _m['tae'] = TAEHV(str(hub_file('lightx2v/Autoencoders', f'{name}.safetensors'))).to(DEVICE).eval()
    return _m['tae']


def release():
    _m.clear(); empty_cache()


def _stats(v):
    mean = torch.tensor(v.config.latents_mean).view(1, 16, 1, 1, 1)
    std = torch.tensor(v.config.latents_std).view(1, 16, 1, 1, 1)
    return mean, std


def encode(video, enc='vae'):
    """video [1, 3, T, H, W] in [-1, 1] → normalised latents [1, 16, F, h, w] (the DiT's space)."""
    v = vae()
    mean, std = _stats(v)
    if enc == 'vae':
        with torch.no_grad():
            z = v.encode(video.to(DEVICE, torch.float32)).latent_dist.mode().float().cpu()
        return (z - mean) / std
    # the tiny encoder (lighttaew2_1): NTCHW in [0, 1]; its latents are the VAE's, unnormalised
    t = tae()
    x = ((video + 1) / 2).clamp(0, 1).permute(0, 2, 1, 3, 4)
    # TAEHV pads the end to a multiple of 4 and gives 1 + 4k frames 1 + k latents; measured against
    # the VAE (12-15 % relative error per latent frame) this beats any padding at the start
    with torch.no_grad():
        z = t.encode_video(x.to(DEVICE), parallel=True, show_progress_bar=False).float().cpu()
    z = z.permute(0, 2, 1, 3, 4)
    return (z - mean) / std


def decode_tae(lat):
    """normalised latents [16, F, h, w] → [T, H, W, 3] uint8 with the tiny decoder the browser uses."""
    v = vae(); mean, std = _stats(v)
    x = (lat[None].float() * std + mean).permute(0, 2, 1, 3, 4)
    with torch.no_grad():
        y = tae().decode_video(x.to(DEVICE), parallel=True, show_progress_bar=False)[0]
    return (y.permute(0, 2, 3, 1).float().cpu().numpy() * 255).round().clip(0, 255).astype(np.uint8)


def decode_vae(lat):
    v = vae(); mean, std = _stats(v)
    with torch.no_grad():
        y = v.decode((lat[None].float() * std + mean).to(DEVICE)).sample[0]
    return ((y.permute(1, 2, 3, 0).float().cpu().numpy() + 1) * 127.5).round().clip(0, 255).astype(np.uint8)


def conditioning(known, T, H, W, enc='vae'):
    """known: {frame index: PIL image}. Returns the 96-channel VACE context [1, 96, F, h, w]:
    inactive latents (known frames, grey elsewhere), reactive latents (grey), and the 64-channel mask."""
    video = torch.zeros(1, 3, T, H, W)
    mask = torch.ones(1, 1, T, H, W)
    for i, img in known.items():
        a = torch.from_numpy(np.asarray(img.convert('RGB').resize((W, H)), dtype=np.float32) / 127.5 - 1).permute(2, 0, 1)
        video[0, :, i] = a; mask[0, :, i] = 0
    inactive = encode(video * (1 - mask), enc)
    reactive = encode(video * mask, enc)
    # the mask, 8×8 pixels folded into 64 channels, frames to latent frames by nearest
    F, h, w = (T - 1) // 4 + 1, H // 8, W // 8
    m = mask[0, 0].view(T, h, 8, w, 8).permute(2, 4, 0, 1, 3).flatten(0, 1)
    m = torch.nn.functional.interpolate(m[None], size=(F, h, w), mode='nearest-exact')
    return torch.cat([inactive, reactive, m], 1)


def rcm_times(steps):
    ang = [math.atan(80.0), *[1.5, 1.4, 1.0][:steps - 1], 0.0]
    return [math.sin(a) / (math.cos(a) + math.sin(a)) for a in ang]


def clip(prompt_emb, known, T=49, H=480, W=832, seed=0, base='rcm', steps=4, enc='vae', scale=1.0,
         previews=None, neg_emb=None, cfg=5.0, shift=3.0):
    """One clip of T frames. known: {frame: PIL}. previews: a list that gets each step's x0 latents."""
    tr = transformer(base)
    cond = conditioning(known, T, H, W, enc).to(DEVICE, DT)
    F, h, w = (T - 1) // 4 + 1, H // 8, W // 8
    ctx = prompt_emb[None].to(DEVICE, DT)
    sc = torch.full((len(tr.config.vace_layers),), float(scale), device=DEVICE, dtype=DT)
    g = torch.Generator('cpu').manual_seed(seed)

    def v_of(x, t, c):
        with torch.no_grad():
            return tr(hidden_states=x.to(DEVICE, DT), timestep=torch.tensor([t], device=DEVICE, dtype=torch.float32),
                      encoder_hidden_states=c, control_hidden_states=cond, control_hidden_states_scale=sc,
                      return_dict=False)[0].float().cpu()
    t0 = time.time()
    if base == 'rcm':
        ts = rcm_times(steps)
        x = torch.randn(1, 16, F, h, w, generator=g) * ts[0]
        for i in range(steps):
            v = v_of(x, ts[i] * 1000, ctx)
            x0 = x - ts[i] * v
            if previews is not None:
                previews.append(x0[0].clone())
            x = (1 - ts[i + 1]) * x0 + ts[i + 1] * torch.randn(x.shape, generator=g) if ts[i + 1] > 0 else x0
            print(f'  step {i + 1}/{steps} {time.time() - t0:.0f}s', flush=True)
    else:
        from diffusers import UniPCMultistepScheduler
        sch = UniPCMultistepScheduler(prediction_type='flow_prediction', use_flow_sigmas=True, num_train_timesteps=1000, flow_shift=shift)
        sch.set_timesteps(steps)
        x = torch.randn(1, 16, F, h, w, generator=g)
        nctx = neg_emb[None].to(DEVICE, DT)
        for i, t in enumerate(sch.timesteps):
            vc = v_of(x, float(t), ctx); vu = v_of(x, float(t), nctx)
            v = vu + cfg * (vc - vu)
            if previews is not None:
                s = sch.sigmas[i].item(); previews.append((x - s * v)[0].clone())
            x = sch.step(v, t, x, return_dict=False)[0]
            if i % 5 == 4:
                print(f'  step {i + 1}/{steps} {time.time() - t0:.0f}s', flush=True)
    print(f'clip {W}x{H}x{T} base={base} steps={steps} enc={enc} {time.time() - t0:.0f}s', flush=True)
    return x[0]
