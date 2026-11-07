# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import sys

import torch

torch.set_grad_enabled(False)
from diffusers import SanaTransformer2DModel

snap, out, dtype, how = sys.argv[1], sys.argv[2], sys.argv[3], (sys.argv[4] if len(sys.argv) > 4 else 'script')
dt = torch.float16 if dtype == 'fp16' else torch.float32
tf = SanaTransformer2DModel.from_pretrained(snap + '/transformer', torch_dtype=torch.float32).to(dt).eval()

class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, latents, caption, timestep, guidance):
        x = self.m(latents.to(dt), encoder_hidden_states=caption.to(dt), timestep=timestep.to(dt), guidance=guidance.to(dt), return_dict=False)[0]
        return x.float()

w = Wrap(tf).eval()
args = (torch.randn(1, 32, 32, 32), torch.randn(1, 11, 2304), torch.tensor([0.78]), torch.tensor([0.45]))
names = dict(input_names=['latents', 'caption', 'timestep', 'guidance'], output_names=['velocity'])
if how == 'dynamo':
    h, wd, t = torch.export.Dim('h', min=8, max=128), torch.export.Dim('w', min=8, max=128), torch.export.Dim('t', min=1, max=512)
    prog = torch.onnx.export(w, args, dynamo=True, opset_version=18, dynamic_shapes={'latents': {2: h, 3: wd}, 'caption': {1: t}, 'timestep': None, 'guidance': None},
                             external_data=True, optimize=True, **names)
    prog.save(out, external_data=True)
else:
    torch.onnx.export(w, args, out, dynamo=False, opset_version=18, do_constant_folding=True,
                      dynamic_axes={'latents': {2: 'h', 3: 'w'}, 'caption': {1: 't'}, 'velocity': {2: 'h', 3: 'w'}}, **names)
print('saved', out)
