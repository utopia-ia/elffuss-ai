# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import json, sys, os, numpy as np, torch
from safetensors.torch import load_file
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gemma_encoder import GemmaEncoder
torch.set_grad_enabled(False)
snap, ref, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
cfg = json.load(open(snap + '/text_encoder/config.json'))
sd = {}
for f in sorted(os.listdir(snap + '/text_encoder')):
    if f.endswith('.safetensors') and not f.startswith('._'): sd.update(load_file(os.path.join(snap, 'text_encoder', f)))
sd = {k.removeprefix('model.'): v for k, v in sd.items()}
emb = sd['embed_tokens.weight'].float()
enc = GemmaEncoder(sd, cfg).eval()
d = np.load(ref + '/tensors.npz')
n = int(d['attention_mask'].sum())
ids = torch.from_numpy(d['input_ids'][:, :n])
h = enc(emb[ids])
r = torch.from_numpy(d['te_hidden'][:, :n])
print('max abs diff vs pipeline', float((h - r).abs().max()), 'ref absmax', float(r.abs().max()))
np.save(out + '/embed_fp32.npy', emb.numpy())
import onnx
torch.onnx.export(enc, (emb[ids],), out + '/tmp_encoder.onnx', dynamo=False, opset_version=18, do_constant_folding=True,
                  input_names=['embeds'], output_names=['hidden'], dynamic_axes={'embeds': {1: 't'}, 'hidden': {1: 't'}})
m = onnx.load(out + '/tmp_encoder.onnx')
onnx.save(m, out + '/encoder.onnx', save_as_external_data=True, all_tensors_to_one_file=True, location='encoder.onnx.data')
for f in os.listdir(out):
    if f not in ('encoder.onnx', 'encoder.onnx.data', 'embed_fp32.npy'): os.remove(os.path.join(out, f))
print('saved')
