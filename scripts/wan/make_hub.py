# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Lay out the files we would host (a Hugging Face repo, part "web") under tmp/hub, and write a
# registry with the text-to-video model pinned to them (placeholder revision) for local runs.
#   python make_hub.py <t5dir> <ditdir> <tae.onnx> <out registry.json>
import hashlib, json, os, pathlib, sys
import os as _os
WORK = pathlib.Path(_os.environ.get('WAN_WORK') or pathlib.Path(__file__).resolve().parents[2] / 'tmp')  # scratch: ref/, wan_base/, out/, onnx/
TMP = WORK
HUB = TMP / 'hub' / 'web'
PLACEHOLDER = '0' * 40
WEB_REPO = 'UtopiaIA/Wan2.1-T2V-1.3B-web'
BASE_REPO, BASE_REV = 'Wan-AI/Wan2.1-T2V-1.3B', '37ec512624d61f7aa208f7ea8140a131f93afc9a'

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 24), b''): h.update(b)
    return h.hexdigest()

def link(src, rel):
    dst = HUB / rel; dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() or dst.is_symlink(): dst.unlink()
    os.symlink(os.path.abspath(src), dst)

t5, dit, tae, out = map(pathlib.Path, sys.argv[1:5])
for f in sorted(t5.glob('encoder_*.onnx*')) + [t5 / 'embed_q4.bin']: link(f, f't5/{f.name}')
for f in sorted(dit.glob('*.onnx*')): link(f, f'dit/{f.name}')
link(tae, 'vae/taew2_1_light.onnx')
files = {}
for p in sorted(HUB.rglob('*')):
    if p.is_file():
        rel = str(p.relative_to(HUB)); files[rel] = {'size': p.stat().st_size, 'sha256': sha(p)}
tree = json.load(open(TMP / 'research' / 'Wan-AI_Wan2.1-T2V-1.3B.json'))
tok = next(s for s in tree['siblings'] if s['rfilename'] == 'google/umt5-xxl/tokenizer.json')
refs = ['tok:google/umt5-xxl/tokenizer.json'] + [f'web:{k}' for k in files]
model = {
  'task': 'text-to-video', 'name': {'es': 'Wan 2.1 T2V 1.3B (rCM, 4 pasos)', 'en': 'Wan 2.1 T2V 1.3B (rCM, 4 steps)'},
  'license': 'Apache-2.0', 'author': 'UtopiaIA',
  'base': {'name': 'Wan2.1-T2V-1.3B', 'author': 'Wan-AI', 'url': f'https://huggingface.co/{BASE_REPO}', 'license': 'Apache-2.0'},
  'flag': None, 'redistributes': True, 'runtime': 'onnxruntime-web', 'pipeline': None, 'sampler': 'rcm',
  'parts': {
    'tok': {'repo': BASE_REPO, 'revision': BASE_REV, 'license': 'Apache-2.0', 'author': 'Wan-AI',
            'files': {'google/umt5-xxl/tokenizer.json': {'size': tok['size'], 'sha256': tok['lfs']['sha256']}}},
    'web': {'repo': WEB_REPO, 'revision': PLACEHOLDER, 'license': 'Apache-2.0', 'author': 'UtopiaIA', 'files': files},
  },
  'devices': {'webgpu': [{'when': 'shader-f16', 'dtype': 'q8f16', 'files': refs,
                          'bytes': tok['size'] + sum(f['size'] for f in files.values())}]},
  'notes': {'es': None, 'en': None},
}
reg = {'schema': 1, 'tasks': {'text-to-video': {'default': 'text-to-video/wan2.1-t2v-1.3b-rcm'}}, 'models': {'text-to-video/wan2.1-t2v-1.3b-rcm': model}}
out.write_text(json.dumps(reg, indent=1))
print('files', len(files), 'bytes', model['devices']['webgpu'][0]['bytes'])
