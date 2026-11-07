# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Fixture of VACE's control for the JS tests (tests/fixtures/video-gen/control.json): the folded
# mask from diffusers' own WanVACEPipeline.prepare_masks for a small clip (9 frames of 48 × 32, frame 0
# known only in a rectangle, frame 8 known whole), and the control tokens of small seeded latents
# in the order the exported graph reads them (scripts/wan/export_vace.control_tokens).
#   python -I control_fixture.py
import json, pathlib, sys
import numpy as np
import torch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'wan'))
from diffusers import WanVACEPipeline  # noqa: E402

T, H, W = 9, 32, 48
rect = {'x': 8, 'y': 8, 'w': 24, 'h': 16}
mask = np.ones((T, H, W), np.float32)
mask[0, rect['y']:rect['y'] + rect['h'], rect['x']:rect['x'] + rect['w']] = 0
mask[8] = 0


class Stub:
    vae_scale_factor_temporal, vae_scale_factor_spatial = 4, 8
    transformer = type('T', (), {'config': type('C', (), {'patch_size': (1, 2, 2)})()})()


# no reference pictures: an empty list, as the pipeline passes it (None would add a padding frame)
m = WanVACEPipeline.prepare_masks(Stub(), torch.from_numpy(mask)[None, None], [[]])[0].numpy()  # [64, F, h, w]
F, h, w = m.shape[1:]
rng = np.random.default_rng(3)
inactive = rng.integers(-9, 9, (16, F, h, w)).astype(np.float32)
reactive = rng.integers(-9, 9, (16, F, h, w)).astype(np.float32)
sys.path.insert(0, str(HERE.parent / 'wan'))
from export_vace import control_tokens  # noqa: E402
tok = control_tokens(np.concatenate([inactive, reactive, m]))
out = {
    'source': 'scripts/storyboard/control_fixture.py', 'frames': T, 'width': W, 'height': H, 'rect': rect,
    'mask': m.reshape(-1).tolist(), 'inactive': inactive.reshape(-1).tolist(), 'reactive': reactive.reshape(-1).tolist(),
    'tokens': tok.reshape(-1).tolist(), 'shape': list(tok.shape),
}
dst = HERE.parents[1] / 'tests' / 'fixtures' / 'video-gen' / 'control.json'
dst.write_text(json.dumps(out))
print('wrote', dst, 'mask', m.shape, 'tokens', tok.shape)
