# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# The three test plans with the weights the browser would use (SB_FAKEQ, fp16 activations), in one
# process so the quantized transformer is built once. Run it once per VACE bit width:
#   SB_DTYPE=fp16 SB_FAKEQ=8,8 python -I compare_bits.py q8
#   SB_DTYPE=fp16 SB_FAKEQ=8,4 python -I compare_bits.py q4
import pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run  # noqa: E402

tag = sys.argv[1]
for plan, extra in (('fox-wakes', ['--carry', '5']), ('fox-snow', []), ('astronaut-s60', [])):
    sys.argv = ['run.py', str(HERE / 'plans' / f'{plan}.json'), '--reuse-keyframes', '--tag', tag, *extra]
    run.main()
