# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Shared pieces of the storyboard reference (Python, PyTorch): where the weights and
# the outputs live, image helpers, the text embeddings of Wan (UMT5-XXL, cached on disk).
import hashlib, json, math, os, pathlib, subprocess, sys
import numpy as np
import torch
from PIL import Image

HERE = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(os.environ.get('SB_OUT') or HERE.parents[1] / 'tmp' / 'storyboard')  # results, inputs/, emb/
SANA_CACHE = os.environ.get('SB_SANA_CACHE')  # a hub cache dir holding SANA-Sprint, if not HF_HOME's
TAEHV_DIR = pathlib.Path(os.environ.get('SB_TAEHV', HERE.parents[1] / 'tmp' / 'ref' / 'taehv'))
DEVICE = os.environ.get('SB_DEVICE') or ('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
FPS = 16


def snapshot(repo, cache_dir=None, **kw):
    # the newest snapshot folder of the cache (partial downloads with allow_patterns are fine)
    root = pathlib.Path(cache_dir or pathlib.Path(os.environ.get('HF_HOME', pathlib.Path.home() / '.cache/huggingface')) / 'hub')
    snaps = sorted((root / ('models--' + repo.replace('/', '--')) / 'snapshots').glob('[!._]*'), key=lambda p: p.stat().st_mtime)
    if not snaps:
        raise FileNotFoundError(f'{repo} is not in {root}')
    return snaps[-1]


def hub_file(repo, name):
    from huggingface_hub import hf_hub_download
    return pathlib.Path(hf_hub_download(repo, name, local_files_only=True))


def empty_cache():
    mod = getattr(torch, DEVICE.split(':')[0], None)
    if mod is not None and hasattr(mod, 'empty_cache'):
        mod.empty_cache()


def fit(img, w, h):
    """Scale to cover w×h and crop the centre: the photo keeps its proportions."""
    img = img.convert('RGB')
    s = max(w / img.width, h / img.height)
    r = img.resize((max(w, round(img.width * s)), max(h, round(img.height * s))), Image.LANCZOS)
    x, y = (r.width - w) // 2, (r.height - h) // 2
    return r.crop((x, y, x + w, y + h))


def to_pil(frames):
    """[T, H, W, 3] uint8 → list of PIL images."""
    return [Image.fromarray(f) for f in frames]


def write_mp4(frames, path, fps=FPS):
    T, H, W, _ = frames.shape
    p = subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(fps), '-i', '-',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', str(path)], input=np.ascontiguousarray(frames).tobytes())
    if p.returncode:
        raise RuntimeError('ffmpeg failed')


_EMB = OUT / 'emb'


def wan_embeddings(prompts, repo='Wan-AI/Wan2.1-VACE-1.3B-diffusers'):
    """UMT5-XXL states of each prompt (bf16 encoder on the CPU, like the official code), cached by text."""
    _EMB.mkdir(parents=True, exist_ok=True)
    keys = [hashlib.sha1(p.encode()).hexdigest()[:16] for p in prompts]
    todo = [(p, k) for p, k in zip(prompts, keys) if not (_EMB / f'{k}.pt').exists()]
    if todo:
        from transformers import AutoTokenizer, UMT5EncoderModel
        snap = snapshot('Wan-AI/Wan2.1-VACE-1.3B-diffusers')
        tok = AutoTokenizer.from_pretrained(snap / 'tokenizer')
        enc = UMT5EncoderModel.from_pretrained(snap / 'text_encoder', torch_dtype=torch.bfloat16).eval()
        for p, k in todo:
            t = tok([p], padding='max_length', max_length=512, truncation=True, add_special_tokens=True, return_attention_mask=True, return_tensors='pt')
            n = int(t.attention_mask.sum())
            with torch.no_grad():
                h = enc(t.input_ids, t.attention_mask).last_hidden_state[0, :n].float()
            # the pipeline pads with zeros up to 512; the transformer sees those zeros too
            full = torch.zeros(512, h.shape[1]); full[:n] = h
            torch.save({'prompt': p, 'tokens': n, 'states': full}, _EMB / f'{k}.pt')
            print('emb', n, 'tokens:', p[:70], flush=True)
        del enc
    return [torch.load(_EMB / f'{k}.pt')['states'] for k in keys]


def sheet(rows, path, thumb_w=320, label_h=18):
    """rows: list of (title, [PIL images]) → one PNG, a row per entry, images scaled to thumb_w."""
    from PIL import ImageDraw
    cols = max(len(r[1]) for r in rows)
    first = rows[0][1][0]
    tw = thumb_w; th = round(first.height * tw / first.width)
    W = cols * (tw + 4) + 4
    H = sum(label_h + round(r[1][0].height * tw / r[1][0].width) + 6 for r in rows) + 4
    out = Image.new('RGB', (W, H), (250, 248, 242))
    d = ImageDraw.Draw(out)
    y = 4
    for title, imgs in rows:
        d.text((6, y + 2), title, fill=(30, 30, 30))
        y += label_h
        rh = round(imgs[0].height * tw / imgs[0].width)
        for i, im in enumerate(imgs):
            out.paste(im.convert('RGB').resize((tw, rh), Image.LANCZOS), (4 + i * (tw + 4), y))
        y += rh + 6
    out.save(path)
    return path


def spread(n, k):
    """k indices evenly spread over 0..n-1, both ends included."""
    return [round(i * (n - 1) / (k - 1)) for i in range(k)] if k > 1 else [0]
