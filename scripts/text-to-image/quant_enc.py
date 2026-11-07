# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import sys, os, onnx
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer, DefaultWeightOnlyQuantConfig, HQQWeightOnlyQuantConfig
src, dst, block, sym, algo = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4] == 'sym', sys.argv[5]
m = onnx.load(src)
cfg = HQQWeightOnlyQuantConfig(block_size=block, bits=4) if algo == 'hqq' else DefaultWeightOnlyQuantConfig(block_size=block, is_symmetric=sym, accuracy_level=None)
q = MatMulNBitsQuantizer(m, block_size=block, is_symmetric=sym, algo_config=cfg)
q.process()
os.makedirs(os.path.dirname(dst), exist_ok=True)
q.model.save_model_to_file(dst, use_external_data_format=False)
print('saved', dst, os.path.getsize(dst))
