# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# SANA's DC-AE encoder as ONNX, for SDEdit (a picture from another picture): image [1, 3, H, W]
# in [-1, 1] → latents [1, 32, H/32, W/32], not yet scaled (as AutoencoderDC.encode().latent).
# Exported like the decoder (export_vae.py), then checked against PyTorch in fp32 on the CPU.
#   python export_vae_encoder.py <snapshot> <out.onnx> fp16|fp32
import sys

import numpy as np
import torch

torch.set_grad_enabled(False)
from diffusers import AutoencoderDC

snap, out, dtype = sys.argv[1], sys.argv[2], sys.argv[3]
dt = torch.float16 if dtype == 'fp16' else torch.float32


def movedim(self, source, destination):
    nd = self.dim()
    s, d = source % nd, destination % nd
    perm = [i for i in range(nd) if i != s]
    perm.insert(d, s)
    return self.permute(*perm)


torch.Tensor.movedim = movedim
vae32 = AutoencoderDC.from_pretrained(snap + '/vae', torch_dtype=torch.float32).eval()
vae = AutoencoderDC.from_pretrained(snap + '/vae', torch_dtype=torch.float32).to(dt).eval()


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, image):
        return self.m.encoder(image.to(dt)).float()


torch.onnx.export(Wrap(vae).eval(), (torch.randn(1, 3, 256, 256),), out, dynamo=False, opset_version=18, do_constant_folding=True,
                  input_names=['image'], output_names=['latents'], dynamic_axes={'image': {2: 'H', 3: 'W'}, 'latents': {2: 'h', 3: 'w'}})

import onnxruntime as ort  # noqa: E402
x = torch.rand(1, 3, 384, 640) * 2 - 1
ref = vae32.encoder(x).numpy()
got = ort.InferenceSession(out, providers=['CPUExecutionProvider']).run(None, {'image': x.numpy()})[0]
rel = float(np.linalg.norm(got - ref) / np.linalg.norm(ref))
print('saved', out, 'latents', got.shape, f'rel L2 vs fp32 {rel:.2e}')
