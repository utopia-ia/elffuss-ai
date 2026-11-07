# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import json
import os
import sys
import time

import numpy as np
import torch

snap, out, steps, seed, width, height, prompt = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), sys.argv[7]
os.makedirs(out, exist_ok=True)
torch.set_grad_enabled(False)

import diffusers.pipelines.sana.pipeline_sana_sprint as P
import diffusers.schedulers.scheduling_scm as S
from diffusers import SanaSprintPipeline

rec = {'randn': [], 'calls': [], 'steps': []}
orig_randn_p, orig_randn_s = P.randn_tensor, S.randn_tensor

def rp(*a, **k):
    x = orig_randn_p(*a, **k)
    rec['randn'].append(x.detach().float().numpy().copy())
    return x

def rs(*a, **k):
    x = orig_randn_s(*a, **k)
    rec['randn'].append(x.detach().float().numpy().copy())
    return x

P.randn_tensor, S.randn_tensor = rp, rs

pipe = SanaSprintPipeline.from_pretrained(snap, torch_dtype=torch.float32)
pipe.to('cpu')

tf_forward = pipe.transformer.forward

def tf_hook(hidden_states, encoder_hidden_states=None, timestep=None, guidance=None, encoder_attention_mask=None, **kw):
    r = tf_forward(hidden_states, encoder_hidden_states=encoder_hidden_states, timestep=timestep, guidance=guidance,
                   encoder_attention_mask=encoder_attention_mask, **kw)
    rec['calls'].append({
        'hidden_states': hidden_states.float().numpy().copy(),
        'encoder_hidden_states': encoder_hidden_states.float().numpy().copy(),
        'encoder_attention_mask': encoder_attention_mask.float().numpy().copy(),
        'timestep': timestep.float().numpy().copy(),
        'guidance': guidance.float().numpy().copy(),
        'out': r[0].float().numpy().copy(),
    })
    return r

pipe.transformer.forward = tf_hook

te_forward = pipe.text_encoder.forward

def te_hook(input_ids=None, attention_mask=None, **kw):
    r = te_forward(input_ids, attention_mask=attention_mask, **kw)
    rec['te'] = {'input_ids': input_ids.numpy().copy(), 'attention_mask': attention_mask.numpy().copy(), 'hidden': r[0].float().numpy().copy()}
    return r

pipe.text_encoder.forward = te_hook

step = pipe.scheduler.step

def step_hook(model_output, timestep, sample, generator=None, **kw):
    r = step(model_output, timestep, sample, generator=generator, **kw)
    rec['steps'].append({'model_output': model_output.float().numpy().copy(), 'timestep': np.asarray(timestep.float().numpy()).copy(),
                         'sample': sample.float().numpy().copy(), 'prev': r[0].float().numpy().copy(), 'x0': r[1].float().numpy().copy()})
    return r

pipe.scheduler.step = step_hook

dec = pipe.vae.decode

def dec_hook(z, **kw):
    r = dec(z, **kw)
    rec['vae_in'] = z.float().numpy().copy()
    rec['vae_out'] = r[0].float().numpy().copy()
    return r

pipe.vae.decode = dec_hook

g = torch.Generator('cpu').manual_seed(seed)
t0 = time.time()
kw = {} if steps == 2 else {'intermediate_timesteps': None}
img = pipe(prompt=prompt, num_inference_steps=steps, generator=g, width=width, height=height, **kw).images[0]
img.save(os.path.join(out, 'image.png'))

np.savez_compressed(os.path.join(out, 'tensors.npz'),
                    input_ids=rec['te']['input_ids'], attention_mask=rec['te']['attention_mask'], te_hidden=rec['te']['hidden'],
                    vae_in=rec['vae_in'], vae_out=rec['vae_out'],
                    **{f'randn{i}': x for i, x in enumerate(rec['randn'])},
                    **{f'call{i}_{k}': v for i, c in enumerate(rec['calls']) for k, v in c.items()},
                    **{f'step{i}_{k}': v for i, c in enumerate(rec['steps']) for k, v in c.items()})
json.dump({'prompt': prompt, 'seed': seed, 'steps': steps, 'width': width, 'height': height, 'calls': len(rec['calls']),
           'randn': len(rec['randn']), 'image': list(img.size)}, open(os.path.join(out, 'meta.json'), 'w'), indent=1)
print('done', out, img.size)
