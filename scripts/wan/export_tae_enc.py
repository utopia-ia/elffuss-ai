# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# The lighttaew2_1 encoder as one ONNX graph that encodes 4 frames (one latent frame) with the
# memory of the previous chunk: x [4, 3, H, W] in [0, 1] and mem_0..mem_8 in, z [1, 16, H/8, W/8]
# out in the DiT's normalised space, with the memories for the next chunk. A clip of 1 + 4k
# frames is padded at the end with its last frame to 4(k + 1), as TAEHV.encode_video does, and
# gives 1 + k latent frames. Checked chunk by chunk against TAEHV.encode_video.
#   python export_tae_enc.py <taehv dir> <lighttaew2_1.safetensors> <vae config.json> <out.onnx>
import json, pathlib, sys
import numpy as np
import torch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main():
    taehv_dir, weights, vae_cfg, out = sys.argv[1:5]
    sys.path.insert(0, taehv_dir)
    from taehv import TAEHV
    from vace_onnx import tae_encoder_stream, tae_encoder_mem_shapes
    cfg = json.loads(pathlib.Path(vae_cfg).read_text())
    tae = TAEHV(weights).eval()
    m = tae_encoder_stream(tae, cfg['latents_mean'], cfg['latents_std'])
    H, W = 48, 64
    x = torch.rand(4, 3, H, W)
    mems = [torch.zeros(s) for s in tae_encoder_mem_shapes(H, W)]
    names = ['x'] + [f'mem_{i}' for i in range(9)]
    outs = ['z'] + [f'new_mem_{i}' for i in range(9)]
    dyn = {'x': {2: 'H', 3: 'W'}, 'z': {2: 'h', 3: 'w'}}
    for i in range(9):
        dyn[f'mem_{i}'] = {2: f'mh{i}', 3: f'mw{i}'}; dyn[f'new_mem_{i}'] = {2: f'nh{i}', 3: f'nw{i}'}
    pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(m, (x, *mems), out, input_names=names, output_names=outs, dynamic_axes=dyn, opset_version=17, dynamo=False)

    # check: a clip of 17 frames (5 latents) at another size, chunk by chunk, against encode_video
    import onnxruntime as ort
    H, W = 96, 160
    clip = torch.rand(1, 17, 3, H, W)
    with torch.no_grad():
        ref = tae.encode_video(clip, parallel=True, show_progress_bar=False)[0]  # [T, 16, h, w], raw
    mean = torch.tensor(cfg['latents_mean']).view(1, 16, 1, 1); std = torch.tensor(cfg['latents_std']).view(1, 16, 1, 1)
    ref = ((ref - mean) / std).numpy()
    padded = torch.cat([clip[0], clip[0, -1:].repeat(3, 1, 1, 1)]).numpy()  # 20 frames
    s = ort.InferenceSession(out, providers=['CPUExecutionProvider'])
    mem = [np.zeros(sh, np.float32) for sh in tae_encoder_mem_shapes(H, W)]
    got = []
    for c in range(len(padded) // 4):
        r = s.run(None, {'x': padded[4 * c:4 * c + 4], **{f'mem_{i}': mem[i] for i in range(9)}})
        got.append(r[0]); mem = r[1:]
    got = np.concatenate(got)
    print('latents', got.shape, ref.shape, 'max abs', float(np.abs(got - ref).max()), 'bytes', pathlib.Path(out).stat().st_size)


if __name__ == '__main__':
    main()
