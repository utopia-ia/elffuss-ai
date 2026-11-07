# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Reference UMT5-XXL embeddings with the official Wan 2.1 code: token ids, fp32
# compute (bf16 weights upcast) and bf16 compute (what the official pipeline does
# on a graphics card). Saves one .npz per prompt.
import json, sys, time, pathlib
import os as _os
WORK = pathlib.Path(_os.environ.get('WAN_WORK') or pathlib.Path(__file__).resolve().parents[2] / 'tmp')  # scratch: ref/, wan_base/, out/, onnx/
import numpy as np
import torch

HERE = pathlib.Path(__file__).resolve().parent
TMP = WORK
sys.path.insert(0, str(TMP / 'ref'))
from wan.modules.t5 import umt5_xxl  # noqa: E402
from wan.modules.tokenizers import HuggingfaceTokenizer  # noqa: E402

CKPT = TMP / 'wan_base' / 'models_t5_umt5-xxl-enc-bf16.pth'
TOK = TMP / 'wan_base' / 'google' / 'umt5-xxl'
OUT = TMP / 'out' / 't5ref'
OUT.mkdir(parents=True, exist_ok=True)


def main():
    prompts = json.loads((HERE / 'prompts.json').read_text())
    extra = [{'id': f'x{i}', 'prompt': p} for i, p in enumerate(sys.argv[1:])]
    tok = HuggingfaceTokenizer(name=str(TOK), seq_len=512, clean='whitespace')
    t0 = time.time()
    sd = torch.load(CKPT, map_location='cpu', weights_only=True)
    print('loaded state dict', len(sd), 'tensors', f'{time.time() - t0:.0f}s', flush=True)
    model = umt5_xxl(encoder_only=True, return_tokenizer=False, dtype=torch.float32, device='cpu').eval().requires_grad_(False)
    missing = model.load_state_dict({k: v.float() for k, v in sd.items()}, strict=True)
    del sd
    torch.set_num_threads(12)
    for item in prompts + extra:
        ids, mask = tok([item['prompt']], return_mask=True, add_special_tokens=True)
        n = int(mask.gt(0).sum())
        ids = ids[:, :n]
        with torch.no_grad():
            e32 = model(ids, torch.ones_like(ids))[0].numpy()
        np.savez(OUT / f"{item['id']}.npz", ids=ids[0].numpy().astype(np.int32), fp32=e32.astype(np.float32))
        print(item['id'], 'tokens', n, 'norm', float(np.linalg.norm(e32, axis=-1).mean()), flush=True)
    # The official pipeline runs the encoder in bf16: the same prompts in bf16 compute, for the noise floor.
    model = model.to(torch.bfloat16)
    for item in prompts + extra:
        d = dict(np.load(OUT / f"{item['id']}.npz"))
        ids = torch.from_numpy(d['ids'].astype(np.int64))[None]
        with torch.no_grad():
            e16 = model(ids, torch.ones_like(ids))[0].float().numpy()
        d['bf16'] = e16
        np.savez(OUT / f"{item['id']}.npz", **d)
        a, b = d['fp32'], e16
        cos = (a * b).sum(-1) / (np.linalg.norm(a, axis=-1) * np.linalg.norm(b, axis=-1))
        print(item['id'], 'bf16 vs fp32: cos min', float(cos.min()), 'mean', float(cos.mean()), flush=True)


if __name__ == '__main__':
    main()
