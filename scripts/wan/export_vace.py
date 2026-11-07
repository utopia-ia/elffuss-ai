# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# Export Wan 2.1 VACE 1.3B (rCM base) as vctx + vpart0..2 for the browser, reusing the published
# T2V weights: base tensors point into the T2V repo's part*.onnx_data / ctx.onnx_data (graft), only
# the VACE tensors go to vpart*.onnx_data / vctx.onnx_data. Also a test vector from the PyTorch
# model (diffusers, fp32, CPU) on a small grid, and a structural check of a truncated fp32 graph
# with ONNX Runtime on the CPU.
#   python export_vace.py <vace diffusers snapshot> <rcm .pt> <t2v web dir (dit/)> <out dir>
#                         [--vbits 8|4] [--check-only] [--vector 3x16x24]
import argparse, json, pathlib, sys, time
import numpy as np
import torch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import onnx  # noqa: E402
from onnxg import save  # noqa: E402
from dit_onnx import build_ctx, rope_tables, t_freq, patchify  # noqa: E402
from vace_onnx import build_vace_part, build_vctx, vace_state_dict, graft, VACE_LAYERS, CONTROL_CHANNELS  # noqa: E402

GROUPS = [list(range(0, 10)), list(range(10, 20)), list(range(20, 30))]


def strip_prefix(sd):
    for key in ('generator_ema', 'generator', 'model', 'state_dict', 'net', 'ema'):
        if isinstance(sd, dict) and key in sd and isinstance(sd[key], dict):
            sd = sd[key]; break
    out = {}
    for k, v in sd.items():
        if not torch.is_tensor(v):
            continue
        for p in ('model._fsdp_wrapped_module.', '_fsdp_wrapped_module.', 'module.', 'model.', 'net.', '_orig_mod.'):
            if k.startswith(p):
                k = k[len(p):]
        out[k] = v
    return out


def load_base(rcm):
    sd = strip_prefix(torch.load(str(rcm), map_location='cpu', weights_only=False, mmap=True))
    if sd['patch_embedding.weight'].ndim == 2:
        sd['patch_embedding.weight'] = sd['patch_embedding.weight'].reshape(1536, 16, 1, 2, 2)
    return {k: v.float() for k, v in sd.items() if not k.startswith('accum_')}


def load_vace(snap):
    from safetensors.torch import load_file
    dsd = {}
    for f in sorted((pathlib.Path(snap) / 'transformer').glob('[!._]*.safetensors')):
        dsd.update({k: v for k, v in load_file(str(f)).items() if k.startswith('vace_')})
    return {k: v.float() for k, v in vace_state_dict(dsd).items()}, dsd


def control_tokens(c):
    """c [96, F, H, W] → [S, 384] in the patch embedding's (channel, dy, dx) order."""
    ch, f, h, w = c.shape
    t = c.reshape(ch, f, h // 2, 2, w // 2, 2).transpose(1, 2, 4, 0, 3, 5)
    return np.ascontiguousarray(t.reshape(f * (h // 2) * (w // 2), ch * 4))


def flow_tokens(lat):
    c, f, h, w = lat.shape
    return lat.reshape(c, f, h // 2, 2, w // 2, 2).transpose(1, 2, 4, 3, 5, 0).reshape(1, f * (h // 2) * (w // 2), 64)


def reference(snap, base_sd, layers, z, ctrl, ctx, t):
    """The diffusers VACE transformer, rCM base, fp32 on the CPU, truncated to `layers` base blocks."""
    from diffusers import WanVACETransformer3DModel
    from diffusers.loaders.single_file_utils import convert_wan_transformer_to_diffusers
    cfg = WanVACETransformer3DModel.load_config(str(pathlib.Path(snap) / 'transformer'))
    vl = [i for i in VACE_LAYERS if i < layers]
    cfg = {k: v for k, v in cfg.items() if not k.startswith('_')}
    cfg.update(num_layers=layers, vace_layers=vl)
    m = WanVACETransformer3DModel(**cfg)
    full = WanVACETransformer3DModel.from_pretrained(str(pathlib.Path(snap) / 'transformer'), torch_dtype=torch.float32).state_dict()
    full.update(convert_wan_transformer_to_diffusers({k: v.clone() for k, v in base_sd.items()}))
    own = m.state_dict()
    sd = {k: full[k] for k in own}
    m.load_state_dict(sd)
    m.eval()
    with torch.no_grad():
        out = m(hidden_states=torch.from_numpy(z)[None], timestep=torch.tensor([t]), encoder_hidden_states=torch.from_numpy(ctx)[None],
                control_hidden_states=torch.from_numpy(ctrl)[None], return_dict=False)[0][0].numpy()
    return out


def run_ort(graph_dir, names, feeds_common, tokens, ctrl_tok, tf, context):
    import onnxruntime as ort
    so = ort.SessionOptions(); so.log_severity_level = 3
    sess = lambda n: ort.InferenceSession(str(graph_dir / f'{n}.onnx'), so, providers=['CPUExecutionProvider'])
    ckv = dict(zip([o.name for o in sess('ctx').get_outputs()], sess('ctx').run(None, {'context': context})))
    vs = sess('vctx')
    ckv.update(dict(zip([o.name for o in vs.get_outputs()], vs.run(None, {'context': context}))))
    carry, flow = {}, None
    for n in names:
        s = sess(n)
        feeds = {}
        for i in s.get_inputs():
            k = i.name
            feeds[k] = (feeds_common[k] if k in feeds_common else tokens if k == 'tokens' else ctrl_tok if k == 'control'
                        else tf if k == 't_freq' else carry[k] if k in carry else ckv[k])
        outs = dict(zip([o.name for o in s.get_outputs()], s.run(None, feeds)))
        if 'flow' in outs:
            flow = outs['flow']
        if 'hidden_out' in outs:
            carry['hidden'] = outs['hidden_out']; carry['chid'] = outs['chid_out']
        if 'e0' in outs:
            carry['e0'], carry['e'] = outs['e0'], outs['e']
    return flow


def vector_inputs(F, H, Wd, seed=7):
    rng = np.random.default_rng(seed)
    z = rng.standard_normal((16, F, H, Wd)).astype(np.float32)
    ctrl = np.concatenate([rng.standard_normal((32, F, H, Wd)), (rng.random((64, F, H, Wd)) > 0.5)]).astype(np.float32)
    ctx = np.zeros((512, 4096), np.float32); ctx[:23] = rng.standard_normal((23, 4096)) * 0.1
    return z, ctrl, ctx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('snap'); ap.add_argument('rcm'); ap.add_argument('t2v'); ap.add_argument('out')
    ap.add_argument('--vbits', type=int, default=8); ap.add_argument('--check-only', action='store_true')
    ap.add_argument('--vector', default='3x16x24'); ap.add_argument('--t', type=float, default=937.5)
    a = ap.parse_args()
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    base_sd = load_base(a.rcm)
    vace_sd, _ = load_vace(a.snap)
    print('loaded', len(base_sd), 'base and', len(vace_sd), 'VACE tensors', f'{time.time() - t0:.0f}s', flush=True)
    F, H, Wd = map(int, a.vector.split('x'))
    S = F * (H // 2) * (Wd // 2)
    z, ctrl, ctx = vector_inputs(F, H, Wd)
    cos, sin = rope_tables(F, H // 2, Wd // 2)
    common32 = {'rope_cos': cos, 'rope_sin': sin, 'rope_pos': np.arange(S, dtype=np.int64)[None]}

    # 1. structure: a truncated fp32 graph (4 base blocks, 2 VACE blocks) on the CPU against diffusers
    L = 4
    tdir = out / 'check-fp32'; tdir.mkdir(exist_ok=True)
    tb = {k: v for k, v in base_sd.items() if not k.startswith('blocks.') or int(k.split('.')[1]) < L}
    save(build_ctx(tb, mode='fp32').model(), tdir / 'ctx.onnx')
    tv = {k: v for k, v in vace_sd.items() if not k.startswith('vace_blocks.') or int(k.split('.')[1]) < 2}
    save(build_vctx(tb, tv, mode='fp32', count=2).model(), tdir / 'vctx.onnx')
    save(build_vace_part(tb, tv, list(range(L)), True, True, mode='fp32').model(), tdir / 'vpart0.onnx')
    ref = reference(a.snap, base_sd, L, z, ctrl, ctx, a.t)
    got = run_ort(tdir, ['vpart0'], common32, patchify(z)[None], control_tokens(ctrl)[None], t_freq(a.t), ctx[None])
    exp = flow_tokens(ref)
    rel = float(np.linalg.norm(got - exp) / np.linalg.norm(exp))
    print(f'fp32 truncated ({L} blocks) vs diffusers: max abs {np.abs(got - exp).max():.2e}, rel L2 {rel:.2e}', flush=True)
    assert rel < 1e-3, 'the graph does not match the reference'
    if a.check_only:
        return

    # 2. the browser graphs: q8f16 base (grafted onto the T2V files), VACE in vbits
    t2v = pathlib.Path(a.t2v)
    olds = [(t2v / 'dit' / f'part{i}.onnx', t2v / 'dit' / f'part{i}.onnx_data', f'part{i}.onnx_data') for i in range(3)]
    olds.append((t2v / 'dit' / 'ctx.onnx', t2v / 'dit' / 'ctx.onnx_data', 'ctx.onnx_data'))
    manifest = {'mode': 'q8f16', 'vbits': a.vbits, 'groups': GROUPS, 'files': {}, 'reused': {}}
    jobs = [('vctx', lambda: build_vctx(base_sd, vace_sd, mode='q8f16', bits=8, vbits=a.vbits))]
    for gi, blocks in enumerate(GROUPS):
        jobs.append((f'vpart{gi}', lambda gi=gi, blocks=blocks: build_vace_part(base_sd, vace_sd, blocks, gi == 0, gi == len(GROUPS) - 1,
                                                                             mode='q8f16', bits=8, vbits=a.vbits, name=f'wan_vpart{gi}')))
    for name, build in jobs:
        m = build().model()
        # each graph only into its own T2V counterpart: a part must not need another part's weights
        mine = [o for o in olds if o[2] == ('ctx.onnx_data' if name == 'vctx' else name[1:] + '.onnx_data')]
        data, reused = graft(m, f'{name}.onnx_data', mine)
        onnx.save_model(m, str(out / f'{name}.onnx'))
        (out / f'{name}.onnx_data').write_bytes(data)
        locs = sorted({e.value for t in m.graph.initializer for e in t.external_data if e.key == 'location'})
        manifest['files'][name] = locs
        manifest['reused'][name] = reused
        print(f'{name}: new {len(data) / 1e6:.1f} MB, reused {reused / 1e6:.1f} MB from {locs}', flush=True)
    for i in range(3):  # the old data files next to the graphs, for ONNX Runtime on disk and the bench
        for nm in (f'part{i}.onnx_data',):
            p = out / nm
            if not p.exists():
                p.symlink_to((t2v / 'dit' / nm).resolve())
    if not (out / 'ctx.onnx').exists():
        for nm in ('ctx.onnx', 'ctx.onnx_data'):
            (out / nm).symlink_to((t2v / 'dit' / nm).resolve())

    # 3. a test vector of the full model for the WebGPU check
    ref = reference(a.snap, base_sd, 30, z, ctrl, ctx, a.t)
    vec = out / 'vector'; vec.mkdir(exist_ok=True)
    arrays = {'context': ctx[None], 'tokens': patchify(z)[None], 'control': control_tokens(ctrl)[None], 't_freq': t_freq(a.t),
              'flow_ref': flow_tokens(ref)}
    for k, v in arrays.items():
        np.ascontiguousarray(v.astype(np.float32)).tofile(vec / f'{k}.f32')
    manifest['vector'] = {'grid': [F, H // 2, Wd // 2], 't': a.t, 'shapes': {k: list(v.shape) for k, v in arrays.items()}}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=1))
    print('done', f'{time.time() - t0:.0f}s', flush=True)


def _prune(m):
    """Drop initialisers no node uses (after outputs were cut)."""
    used = {i for n in m.graph.node for i in n.input}
    keep = [t for t in m.graph.initializer if t.name in used]
    del m.graph.initializer[:]
    m.graph.initializer.extend(keep)
    return m


if __name__ == '__main__':
    main()
