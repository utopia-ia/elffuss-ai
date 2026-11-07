# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Stage the storyboard's new weights as the repository UtopiaIA/Wan2.1-VACE-1.3B-web (not uploaded:
# the files, their README, LICENSE and NOTICE in one folder), and write the registry entry of the
# storyboard model (text-to-video/wan2.1-vace-1.3b-rcm) with a placeholder revision: the published
# registry plus that model, for the test page. With --cache, lay the staged files out in a weight
# cache ($cache/hf/<repo>/<placeholder>/…) for the test servers.
#   python make_hub_vace.py <vace onnx dir> <tae encoder .onnx> <sana encoder .onnx> <registry/tasks.json>
#                           <hub dir> <out registry.json> [--cache <dir>] [--vbits 8]
import argparse, hashlib, json, os, pathlib, shutil

PLACEHOLDER = '0' * 40
REPO = 'UtopiaIA/Wan2.1-VACE-1.3B-web'
MODEL = 'text-to-video/wan2.1-vace-1.3b-rcm'
SOURCES = {
    'vace': ('Wan-AI/Wan2.1-VACE-1.3B-diffusers', 'ec4d2cb062b548996b179d493fdd05340de702a1'),
    'rcm': ('worstcoder/rcm-Wan', '142d77a331f1516fea772607c1bf25a2785a2505'),
    'tae': ('lightx2v/Autoencoders', '043793f3b3a2ea8db7d0ed8b5a0e8134436d529b'),
    'sana': ('Efficient-Large-Model/Sana_Sprint_0.6B_1024px_diffusers', 'aa76e7f4f4928f378716b6716a2130fba3caf5b1'),
}


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 24), b''):
            h.update(b)
    return h.hexdigest()


def readme(vbits, sizes):
    s = SOURCES
    return f"""---
license: apache-2.0
base_model:
- {s['vace'][0].replace('-diffusers', '')}
- {s['rcm'][0]}
pipeline_tag: image-to-video
library_name: onnxruntime-web
tags:
- wan2.1
- vace
- rcm
- onnx
- webgpu
---

# Wan 2.1 VACE 1.3B (rCM, 4 steps) for the browser (ONNX)

The VACE module of [Wan 2.1 VACE 1.3B](https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B) by Wan-AI,
woven into the few-step [rCM](https://huggingface.co/worstcoder/rcm-Wan) transformer of Wan 2.1 T2V
1.3B, converted to ONNX to run with ONNX Runtime Web on WebGPU, as used by
[Elffuss](https://elffuss.com/) to make a video between keyframes (first and last frame, or the last
frames of the clip before). VACE's 30 base blocks are those of Wan 2.1 T2V 1.3B, so this repository
holds only the VACE weights: its graphs read the transformer's weights from
[UtopiaIA/Wan2.1-T2V-1.3B-web](https://huggingface.co/UtopiaIA/Wan2.1-T2V-1.3B-web)
(`dit/part0…2.onnx_data`, `dit/ctx.onnx_data`, unchanged), which also has the text encoder and the
decoder.

| File | What it is |
|---|---|
| `dit/vctx.onnx` (+ `.onnx_data`) | The prompt graph of the 15 VACE blocks: text states in, their cross-attention keys and values out (also reads `ctx.onnx_data`) |
| `dit/vpart0…2.onnx` (+ `.onnx_data`) | The transformer in three runs with the VACE blocks woven in; each also reads the T2V repository's `part<i>.onnx_data`. VACE linear layers with {vbits}-bit weights (MatMulNBits) |
| `vae/lighttaew2_1_encoder.onnx` | The lighttaew2_1 encoder, 4 frames at a time with its memories: the known frames to latents |
| `sana/vae_encoder_fp16.onnx` | The DC-AE encoder of SANA-Sprint 0.6B, for keyframes made from a picture (SDEdit) |

New bytes: {sizes / 1e6:.0f} MB. The sampler is the rCM one of the T2V repository (4 steps, no
guidance). Because of the quantised weights, a seed does not give the video of the original model.

## Licence

Apache-2.0, as the originals. See NOTICE for the sources and their authors.
"""


def notice(vbits):
    s = SOURCES
    return f"""Wan 2.1 VACE 1.3B (rCM, 4 steps), ONNX conversion for the browser
Converted by UtopiaIA. Apache License 2.0.

Derived from:
- {s['vace'][0]} (revision {s['vace'][1]}), by Wan-AI,
  Apache License 2.0: the VACE module (weights in {vbits} bits) and the architecture.
- {s['rcm'][0]} (revision {s['rcm'][1]}), rCM by NVlabs and
  Tsinghua University, Apache License 2.0: the distilled transformer the module is woven into
  (its weights are read from UtopiaIA/Wan2.1-T2V-1.3B-web, not repeated here).
- {s['tae'][0]} (revision {s['tae'][1]}), lighttaew2_1 by
  lightx2v on TAEHV by madebyollin, Apache License 2.0: the encoder.
- {s['sana'][0]} (revision {s['sana'][1]}), SANA-Sprint by
  NVIDIA (Efficient-Large-Model), Apache License 2.0: the DC-AE image encoder.
"""


def main():
    ap = argparse.ArgumentParser()
    for a in ('vace', 'tae', 'sana', 'tasks', 'hub', 'out'):
        ap.add_argument(a)
    ap.add_argument('--cache'); ap.add_argument('--vbits', type=int, default=8)
    ap.add_argument('--license', default=None, help='an Apache-2.0 LICENSE file to copy')
    a = ap.parse_args()
    vace, hub = pathlib.Path(a.vace), pathlib.Path(a.hub)
    if hub.exists():
        shutil.rmtree(hub)
    links = {f'dit/{n}': vace / n for n in ['vctx.onnx', 'vctx.onnx_data'] + [f'vpart{i}.onnx{e}' for i in range(3) for e in ('', '_data')]}
    links['vae/lighttaew2_1_encoder.onnx'] = pathlib.Path(a.tae)
    links['sana/vae_encoder_fp16.onnx'] = pathlib.Path(a.sana)
    for rel, src in links.items():
        dst = hub / rel; dst.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(os.path.abspath(src), dst)
    weights = sum(p.stat().st_size for p in links.values())
    (hub / 'README.md').write_text(readme(a.vbits, weights))
    (hub / 'NOTICE').write_text(notice(a.vbits))
    if a.license:
        shutil.copyfile(a.license, hub / 'LICENSE')
    files = {}
    for p in sorted(hub.rglob('*')):
        if p.is_file() and not p.name.startswith('._'):
            files[str(p.relative_to(hub))] = {'size': p.stat().st_size, 'sha256': sha(p)}

    reg = json.loads(pathlib.Path(a.tasks).read_text())
    t2v, sana = reg['models']['text-to-video/wan2.1-t2v-1.3b-rcm'], reg['models']['text-to-image/sana-sprint-0.6b']
    pick = lambda part, refs: {**part, 'files': {k: v for k, v in part['files'].items() if k in refs}}
    web_refs = [f'web:t5/encoder_{i}.onnx{e}' for i in range(4) for e in ('', '_data')] + ['web:t5/embed_q4.bin', 'web:dit/ctx.onnx', 'web:dit/ctx.onnx_data'] + \
               [f'web:dit/part{i}.onnx_data' for i in range(3)] + ['web:vae/taew2_1_light.onnx']
    sana_refs = ['sana:' + r.split(':', 1)[1] for r in sana['devices']['webgpu'][0]['files'] if r.startswith('main:')]
    sanaw_refs = ['sanaw:' + r.split(':', 1)[1] for r in sana['devices']['webgpu'][0]['files'] if r.startswith('onnx:')]
    sanaw_refs += ['sanaw:' + f for f in sana['parts']['onnx']['files'] if f.endswith('.onnx_data')]
    vace_refs = [f'vace:{k}' for k in files if k.endswith(('.onnx', '.onnx_data'))]
    refs = ['tok:google/umt5-xxl/tokenizer.json'] + web_refs + vace_refs + sana_refs + sanaw_refs
    parts = {
        'tok': pick(t2v['parts']['tok'], {'google/umt5-xxl/tokenizer.json'}),
        'web': pick(t2v['parts']['web'], {r.split(':', 1)[1] for r in web_refs}),
        'vace': {'repo': REPO, 'revision': PLACEHOLDER, 'license': 'Apache-2.0', 'author': 'UtopiaIA', 'files': files},
        'sana': pick(sana['parts']['main'], {r.split(':', 1)[1] for r in sana_refs}),
        'sanaw': pick(sana['parts']['onnx'], {r.split(':', 1)[1] for r in sanaw_refs}),
    }
    refs = [r for r in refs if r.split(':', 1)[1] in parts[r.split(':', 1)[0]]['files']]
    bytes_ = sum(parts[r.split(':', 1)[0]]['files'][r.split(':', 1)[1]]['size'] for r in refs)
    model = {
        'task': 'text-to-video', 'name': {'es': 'Wan 2.1 VACE 1.3B (rCM) y SANA-Sprint', 'en': 'Wan 2.1 VACE 1.3B (rCM) and SANA-Sprint'},
        'license': 'Apache-2.0', 'author': 'UtopiaIA',
        'base': {'name': 'Wan2.1-VACE-1.3B', 'author': 'Wan-AI', 'url': 'https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B', 'license': 'Apache-2.0'},
        'bases': [
            {'name': 'Wan2.1-VACE-1.3B', 'author': 'Wan-AI', 'url': 'https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B', 'license': 'Apache-2.0', 'part': 'vace'},
            *t2v['bases'],
            *[{**b, 'part': 'sana' if b.get('part') == 'main' else 'sanaw' if b.get('part') == 'onnx' else b.get('part')} for b in sana.get('bases', [sana['base']])],
        ],
        'flag': sana.get('flag'), 'redistributes': True, 'runtime': 'onnxruntime-web', 'pipeline': None, 'sampler': 'rcm',
        'parts': parts,
        'devices': {'webgpu': [{'when': 'shader-f16', 'dtype': 'q8f16', 'files': refs, 'bytes': bytes_}]},
        'notes': {'es': 'Las imágenes clave las pinta SANA-Sprint y los clips entre ellas Wan 2.1 VACE en 4 pasos.',
                  'en': 'SANA-Sprint paints the keyframes and Wan 2.1 VACE makes the clips between them in 4 steps.'},
    }
    reg['models'][MODEL] = model
    pathlib.Path(a.out).write_text(json.dumps(reg, indent=1, ensure_ascii=False))
    if a.cache:
        root = pathlib.Path(a.cache) / 'hf' / REPO / PLACEHOLDER
        if root.exists():
            shutil.rmtree(root)
        for rel in files:
            dst = root / rel; dst.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(os.path.realpath(hub / rel), dst)
    print(f'staged {len(files)} files, new bytes {weights / 1e6:.0f} MB; model {MODEL}: {len(refs)} files, {bytes_ / 1e9:.2f} GB in all')


if __name__ == '__main__':
    main()
