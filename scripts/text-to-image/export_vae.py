# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import sys

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
vae = AutoencoderDC.from_pretrained(snap + '/vae', torch_dtype=torch.float32).to(dt).eval()

class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, latents):
        return self.m.decoder(latents.to(dt)).float()

w = Wrap(vae).eval()
torch.onnx.export(w, (torch.randn(1, 32, 16, 16),), out, dynamo=False, opset_version=18, do_constant_folding=True,
                  input_names=['latents'], output_names=['image'], dynamic_axes={'latents': {2: 'h', 3: 'w'}, 'image': {2: 'H', 3: 'W'}})
print('saved', out)
