# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Writes tests/fixtures/video-gen/reference.json and tokens.json from the reference side:
# the shared noise generator, the official Wan 2.1 T5 relative-position buckets, the rCM
# sampler times (TurboDiffusion's inference script) and the ids of Wan's own tokenizer.
#   WAN_WORK=<scratch with ref/ (Wan2.1 code) and wan_base/ (the pinned repo)> python -I fixtures.py
import json, math, pathlib, sys
import numpy as np, torch
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import wanmods  # noqa: E402  (puts WORK/ref on the path)
from wan.modules.t5 import T5RelativeEmbedding  # noqa: E402
from wan.modules.tokenizers import HuggingfaceTokenizer  # noqa: E402

OUT = HERE.parents[1] / 'tests' / 'fixtures' / 'video-gen'
rel = T5RelativeEmbedding(32, 64, bidirectional=True)
b = rel._relative_position_bucket(torch.arange(300).unsqueeze(0) - torch.arange(300).unsqueeze(1)).numpy()
n0 = wanmods.noise(11, 0, 4000)
ang = [math.atan(80.0), 1.5, 1.4, 1.0, 0.0]
fx = {
    'source': 'scripts/wan/fixtures.py',
    'noise': {'seed': 11, 'stream': 0, 'first': n0[:8].tolist(), 'at3001': n0[3001:3005].tolist(), 'mean': float(n0.mean()), 'std': float(n0.std())},
    'noise2': {'seed': 4294967295, 'stream': 3, 'first': wanmods.noise(4294967295, 3, 10).tolist()},
    'buckets300': {'rows': [0, 7, 150, 299], 'values': [b[r].tolist() for r in [0, 7, 150, 299]]},
    'rcmTimes4': [math.sin(a) / (math.cos(a) + math.sin(a)) for a in ang],
}
(OUT / 'reference.json').write_text(json.dumps(fx))
tok = HuggingfaceTokenizer(name=str(wanmods.WORK / 'wan_base' / 'google' / 'umt5-xxl'), seq_len=512, clean='whitespace')
cases = json.loads((HERE / 'tokenizer-cases.json').read_text()) + [p['prompt'] for p in json.loads((HERE / 'prompts.json').read_text())]
out = []
for c in cases:
    ids, mask = tok([c], return_mask=True, add_special_tokens=True)
    out.append({'text': c, 'ids': ids[0, :int(mask.sum())].tolist()})
(OUT / 'tokens.json').write_text(json.dumps(out, ensure_ascii=False, indent=0))
print('wrote', len(out), 'token cases')
