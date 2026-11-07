# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# A small ONNX graph builder: nodes, initialisers, and quantised linear layers
# (MatMulNBits) packed the way ONNX Runtime reads them.
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

MS = 'com.microsoft'
NP2ONNX = {np.dtype('float32'): TensorProto.FLOAT, np.dtype('float16'): TensorProto.FLOAT16,
           np.dtype('int64'): TensorProto.INT64, np.dtype('int32'): TensorProto.INT32, np.dtype('uint8'): TensorProto.UINT8}


def quantize_blocks(w, bits=4, block=32, search=True):
    """w: [N, K] float → (packed [N, nb, block*bits/8] uint8, scales [N, nb] f32, zp [N, nb] uint8, dequant [N, K] f32)."""
    w = np.asarray(w, np.float32)
    n, k = w.shape
    nb = (k + block - 1) // block
    pad = nb * block - k
    wp = np.pad(w, ((0, 0), (0, pad))) if pad else w
    wb = wp.reshape(n, nb, block)
    qmax = (1 << bits) - 1
    lo0 = np.minimum(wb.min(-1), 0.0)
    hi0 = np.maximum(wb.max(-1), 0.0)
    best = None
    ratios = [1.0, 0.97, 0.94, 0.91, 0.88, 0.85, 0.82, 0.79] if search else [1.0]
    for r in ratios:
        lo, hi = lo0 * r, hi0 * r
        scale = np.maximum((hi - lo) / qmax, 1e-12)
        zp = np.clip(np.round(-lo / scale), 0, qmax)
        q = np.clip(np.round(wb / scale[..., None]) + zp[..., None], 0, qmax)
        deq = (q - zp[..., None]) * scale[..., None]
        err = ((deq - wb) ** 2).sum(-1)
        if best is None:
            best = [err, q, scale, zp]
        else:
            m = err < best[0]
            best[0] = np.where(m, err, best[0])
            best[1] = np.where(m[..., None], q, best[1])
            best[2] = np.where(m, scale, best[2])
            best[3] = np.where(m, zp, best[3])
    _, q, scale, zp = best
    q = q.astype(np.uint8)
    deq = ((q.astype(np.float32) - zp[..., None]) * scale[..., None]).reshape(n, nb * block)[:, :k]
    if bits == 4:
        packed = (q[..., 0::2] | (q[..., 1::2] << 4)).astype(np.uint8)
    elif bits == 8:
        packed = q
    else:
        raise ValueError(bits)
    return packed, scale.astype(np.float32), zp.astype(np.uint8), deq


def pack_zero_points(zp, bits):
    n, nb = zp.shape
    if bits == 8:
        return zp.reshape(-1)
    nbp = (nb + 1) // 2
    z = np.zeros((n, nbp * 2), np.uint8)
    z[:, :nb] = zp
    return (z[:, 0::2] | (z[:, 1::2] << 4)).reshape(-1).astype(np.uint8)


class Graph:
    def __init__(self, name):
        self.name = name
        self.nodes, self.inits, self.inputs, self.outputs = [], [], [], []
        self.n = 0
        self.names = set()

    def uid(self, base):
        self.n += 1
        return f'{base}_{self.n}'

    def init(self, name, arr):
        arr = np.ascontiguousarray(arr)
        if name in self.names:
            raise ValueError('duplicate initialiser ' + name)
        self.names.add(name)
        self.inits.append(numpy_helper.from_array(arr, name))
        return name

    def const(self, arr, base='c'):
        return self.init(self.uid(base), np.asarray(arr))

    def input(self, name, dtype, shape):
        self.inputs.append(helper.make_tensor_value_info(name, dtype, shape))
        return name

    def output(self, name, dtype, shape):
        self.outputs.append(helper.make_tensor_value_info(name, dtype, shape))
        return name

    def op(self, op_type, inputs, outputs=None, n_out=1, domain='', name=None, **attrs):
        if outputs is None:
            outputs = [self.uid(op_type.lower()) for _ in range(n_out)]
        self.nodes.append(helper.make_node(op_type, inputs, outputs, name=name or self.uid('n_' + op_type), domain=domain or None, **attrs))
        return outputs[0] if len(outputs) == 1 else outputs

    # --- layers -------------------------------------------------------------
    def linear(self, x, w, b=None, *, prefix, mode='fp16', bits=4, block=32, act_dtype='float32'):
        """x @ w.T (+ b). w: torch-layout [N, K] numpy float32.
        mode: 'fp32' | 'fp16' (MatMul with fp16 weights) | 'nbits' (MatMulNBits, scales in the activation dtype)."""
        n, k = w.shape
        if mode in ('fp32', 'fp16'):
            dt = np.float32 if mode == 'fp32' else np.float16
            wn = self.init(prefix + '.weight', w.T.astype(dt))
            y = self.op('MatMul', [x, wn])
            if b is not None:
                y = self.op('Add', [y, self.init(prefix + '.bias', b.astype(dt))])
            return y
        packed, scale, zp, _ = quantize_blocks(w, bits=bits, block=block)
        sdt = np.float16 if act_dtype == 'float16' else np.float32
        ins = [x, self.init(prefix + '.qweight', packed), self.init(prefix + '.scales', scale.reshape(-1).astype(sdt)),
               self.init(prefix + '.qzeros', pack_zero_points(zp, bits))]
        if b is not None:
            ins += ['', self.init(prefix + '.bias', b.astype(sdt))]
        return self.op('MatMulNBits', ins, domain=MS, K=k, N=n, bits=bits, block_size=block)

    def model(self, opset=20):
        g = helper.make_graph(self.nodes, self.name, self.inputs, self.outputs, self.inits)
        m = helper.make_model(g, opset_imports=[helper.make_opsetid('', opset), helper.make_opsetid(MS, 1)], producer_name='elffuss-wan-export')
        m.ir_version = 9
        return m


def save(model, path, data_name=None):
    """Save with every initialiser over 1 KB in `<name>.onnx_data` next to it."""
    import os
    path = str(path)
    data_name = data_name or os.path.basename(path) + '_data'
    data_path = os.path.join(os.path.dirname(path), data_name)
    if os.path.exists(data_path):
        os.remove(data_path)
    onnx.save_model(model, path, save_as_external_data=True, all_tensors_to_one_file=True, location=data_name, size_threshold=1024)
    return path, data_path
