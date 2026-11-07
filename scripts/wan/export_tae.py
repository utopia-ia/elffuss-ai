# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# TAEHV decoder (Wan 2.1 latents) as one ONNX graph that decodes a chunk of latent frames
# with the memory of the previous chunk: inputs x [T, 16, h, w] and mem_0..mem_8, outputs
# frames [4T, 3, 8h, 8w] in [0, 1] and the memories for the next chunk. Exact against
# TAEHV.decode_video (the parallel and the sequential forms agree).
import sys, pathlib, numpy as np, torch, torch.nn as nn
import os as _os
WORK = pathlib.Path(_os.environ.get('WAN_WORK') or pathlib.Path(__file__).resolve().parents[2] / 'tmp')  # scratch: ref/, wan_base/, out/, onnx/
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(WORK / 'ref' / 'taehv')); sys.path.insert(0, str(HERE))
from taehv import TAEHV, MemBlock, TGrow
import wanmods

class TaeStream(nn.Module):
    def __init__(self, tae, scaled):
        super().__init__()
        self.blocks = tae.decoder
        self.scaled = scaled
        self.register_buffer('mean', torch.tensor(wanmods.VAE_MEAN).view(1, 16, 1, 1))
        self.register_buffer('std', torch.tensor(wanmods.VAE_STD).view(1, 16, 1, 1))
    def forward(self, x, *mems):
        if self.scaled:
            x = x * self.std + self.mean
        new = []
        k = 0
        for b in self.blocks:
            if isinstance(b, MemBlock):
                past = torch.cat([mems[k][None] if mems[k].dim() == 3 else mems[k], x[:-1]], 0)
                new.append(x[-1:])
                x = b(x, past)
                k += 1
            else:
                x = b(x)
        return (x.clamp(0, 1), *new)

def mem_shapes(h, w):
    out = []
    for i, c, s in [(0, 256, 1), (1, 128, 2), (2, 64, 4)]:
        out += [(1, c, h * s, w * s)] * 3
    return out

if __name__ == '__main__':
    name, scaled, out = sys.argv[1], sys.argv[2] == 'scaled', pathlib.Path(sys.argv[3])
    tae = TAEHV(str(WORK / 'lae' / f'{name}.safetensors')).eval()
    m = TaeStream(tae, scaled).eval()
    h, w = 6, 8
    x = torch.randn(2, 16, h, w)
    mems = [torch.zeros(s) for s in mem_shapes(h, w)]
    names = ['x'] + [f'mem_{i}' for i in range(9)]
    outs = ['frames'] + [f'new_mem_{i}' for i in range(9)]
    dyn = {'x': {0: 'T', 2: 'h', 3: 'w'}, 'frames': {0: 'T4', 2: 'H', 3: 'W'}}
    for i in range(9):
        dyn[f'mem_{i}'] = {2: f'mh{i}', 3: f'mw{i}'}; dyn[f'new_mem_{i}'] = {2: f'nh{i}', 3: f'nw{i}'}
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(m, (x, *mems), str(out), input_names=names, output_names=outs, dynamic_axes=dyn, opset_version=17, dynamo=False)
    # check: decode a real latent chunk by chunk against decode_video
    import onnxruntime as ort
    lat = torch.from_numpy(np.load(sys.argv[4]))  # [16, F, H, W]
    with torch.no_grad():
        ref = tae.decode_video((lat.permute(1, 0, 2, 3)[None] * (m.std[None] if scaled else 1) + (m.mean[None] if scaled else 0)), parallel=True, show_progress_bar=False)[0]
    s = ort.InferenceSession(str(out), providers=['CPUExecutionProvider'])
    H, W = lat.shape[2:]
    mem = [np.zeros(s_, np.float32) for s_ in mem_shapes(H, W)]
    frames = []
    for f in range(lat.shape[1]):
        r = s.run(None, {'x': lat[:, f:f + 1].permute(1, 0, 2, 3).numpy(), **{f'mem_{i}': mem[i] for i in range(9)}})
        frames.append(r[0]); mem = r[1:]
    got = np.concatenate(frames)[3:]
    print('frames', got.shape, ref.shape, 'max abs', float(np.abs(got - ref.numpy()).max()))
