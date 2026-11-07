# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Stage the DC-AE image encoder (export_vae_encoder.py) as a new file of the SANA-Sprint
# browser repository, not uploaded: `<hub>/vae_encoder/model_fp16.onnx` and the README section
# to add. Writes the registry with the text-to-image model's `onnx` part at a placeholder
# revision and the encoder in its variant (for the test page), and with --cache lays the part out
# in a weight cache at that revision (the published files linked, the encoder added).
#   python stage_encoder.py <encoder .onnx> <registry/tasks.json> <hub dir> <out registry.json> [--cache <dir>]
import argparse, hashlib, json, os, pathlib, shutil

PLACEHOLDER = '0' * 40
MODEL = 'text-to-image/sana-sprint-0.6b'
FILE = 'vae_encoder/model_fp16.onnx'
README = """## Image encoder (pictures from pictures)

`vae_encoder/model_fp16.onnx`: the DC-AE encoder of SANA-Sprint 0.6B in float16, image
[1, 3, H, W] in [-1, 1] → latents [1, 32, H/32, W/32] (not scaled), for SDEdit: a picture made
from another one. Exported by UtopiaIA from the original repository's `vae/` at revision
aa76e7f4f4928f378716b6716a2130fba3caf5b1 (Apache-2.0), checked against the float32 encoder
(relative L2 error 9e-4).
"""


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 24), b''):
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    for a in ('encoder', 'tasks', 'hub', 'out'):
        ap.add_argument(a)
    ap.add_argument('--cache')
    a = ap.parse_args()
    hub = pathlib.Path(a.hub)
    if hub.exists():
        shutil.rmtree(hub)
    (hub / 'vae_encoder').mkdir(parents=True)
    os.symlink(os.path.abspath(a.encoder), hub / FILE)
    (hub / 'README-section.md').write_text(README)
    reg = json.loads(pathlib.Path(a.tasks).read_text())
    m = reg['models'][MODEL]
    part = m['parts']['onnx']
    old_rev = part['revision']
    part['files'][FILE] = {'size': (hub / FILE).stat().st_size, 'sha256': sha(hub / FILE)}
    part['revision'] = PLACEHOLDER
    for v in m['devices']['webgpu']:
        v['files'].append('onnx:' + FILE)
        v['bytes'] += part['files'][FILE]['size']
    pathlib.Path(a.out).write_text(json.dumps(reg, indent=1, ensure_ascii=False))
    if a.cache:
        src = pathlib.Path(a.cache) / 'hf' / part['repo'] / old_rev
        dst = pathlib.Path(a.cache) / 'hf' / part['repo'] / PLACEHOLDER
        if dst.exists():
            shutil.rmtree(dst)
        for f in part['files']:
            s = hub / FILE if f == FILE else src / f
            if not s.exists():
                continue
            d = dst / f; d.parent.mkdir(parents=True, exist_ok=True)
            os.symlink(os.path.realpath(s), d)
    print(f'staged {FILE} ({part["files"][FILE]["size"] / 1e6:.0f} MB) for {part["repo"]}; variant {m["devices"]["webgpu"][0]["bytes"] / 1e9:.2f} GB')


if __name__ == '__main__':
    main()
