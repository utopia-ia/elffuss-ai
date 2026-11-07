# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import sys, os, numpy as np
E = np.load(sys.argv[1]); out = sys.argv[2]; os.makedirs(out, exist_ok=True)
V, D = E.shape; B = 32
blk = E.reshape(V, D // B, B)
scale = (np.abs(blk).max(-1) / 7.0).astype(np.float16)
sc = scale.astype(np.float32)[..., None]
q = np.clip(np.round(blk / np.where(sc == 0, 1, sc)), -8, 7).astype(np.int8)
deq = (q.astype(np.float32) * sc).reshape(V, D)
np.save(out + '/embed_q4_deq.npy', deq)
u = (q.reshape(V, D) + 8).astype(np.uint8)            # 0..15
packed = (u[:, 0::2] | (u[:, 1::2] << 4)).astype(np.uint8)   # low nibble = even column
open(out + '/embed_q4.bin', 'wb').write(packed.tobytes())
open(out + '/embed_q4_scales.bin', 'wb').write(scale.tobytes())
err = np.abs(deq - E); print('rows', V, 'dim', D, 'max err', err.max(), 'rel rms', np.sqrt((err**2).mean() / (E**2).mean()))
