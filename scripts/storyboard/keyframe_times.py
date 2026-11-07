# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
# How far SDEdit (from the previous keyframe or the user's photo) can move the picture: one row per
# start time t, next to plain text-to-image with the same seed and style (what keeps a story together
# without any encoder).
#   python -I keyframe_times.py
import pathlib, sys
from PIL import Image
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT, fit, sheet  # noqa: E402
import keyframes as KF  # noqa: E402

TIMES = [1.1, 1.3, 1.45]
rows = []
fox = 'a red fox with a white chest and black-tipped ears, in a misty pine forest at dawn, golden sunrise light through the trees, cinematic wildlife photography, photorealistic'
k0 = Image.open(OUT / 'a-fox-wakes' / 'keyframes' / 'k0.png')
for name, init, prompt, W, H, seed in [
    ('fox stretches (from k0 asleep)', k0, 'a red fox standing on the mossy forest floor stretching, front legs stretched forward, back arched, yawning, ' + fox, 832, 480, 7),
    ('fox photo looks at camera in snow', Image.open(OUT / 'inputs' / 'web-fox-2.png'), 'snow falling, a thin layer of snow on the leaves, the fox facing the camera and looking straight at the viewer, a red fox sitting among autumn leaves in a forest, warm backlight, photorealistic', 624, 624, 11),
    ('astronaut photo waves', Image.open(OUT / 'inputs' / 'web-astronaut.png'), 'the chubby toy astronaut standing on top of the cream egg-shaped moon rock, one arm raised high waving, a chubby cream-white toy astronaut figurine with a big round black glossy visor, grey lunar dust, dark background, macro photography, photorealistic', 624, 624, 21)]:
    imgs = [fit(init, W, H), KF.keyframe(prompt, W, H, seed)]
    imgs += [KF.keyframe(prompt, W, H, seed, init=init, t=t) for t in TIMES]
    rows.append((f'{name}: start | text only (same seed) | SDEdit t=' + ', '.join(map(str, TIMES)), imgs))
out = OUT / 'keyframe-times'; out.mkdir(exist_ok=True)
for i, (_, imgs) in enumerate(rows):
    sheet([rows[i]], out / f'row{i}.png', thumb_w=300)
print('done', out)
