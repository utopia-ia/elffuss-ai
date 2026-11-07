# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import sys, json
from transformers import AutoTokenizer
snap, out = sys.argv[1], sys.argv[2]
tok = AutoTokenizer.from_pretrained(snap + '/tokenizer')
tok.padding_side = 'right'  # as the pipeline sets it
chi = '\n'.join([
  "Given a user prompt, generate an 'Enhanced prompt' that provides detailed visual descriptions suitable for image generation. Evaluate the level of detail in the user prompt:",
  "- If the prompt is simple, focus on adding specifics about colors, shapes, sizes, textures, and spatial relationships to create vivid and concrete scenes.",
  "- If the prompt is already detailed, refine and enhance the existing details slightly without overcomplicating.",
  "Here are examples of how to transform or refine prompts:",
  "- User Prompt: A cat sleeping -> Enhanced: A small, fluffy white cat curled up in a round shape, sleeping peacefully on a warm sunny windowsill, surrounded by pots of blooming red flowers.",
  "- User Prompt: A busy city street -> Enhanced: A bustling city street scene at dusk, featuring glowing street lamps, a diverse crowd of people in colorful clothing, and a double-decker bus passing by towering glass skyscrapers.",
  "Please generate only the enhanced description for the prompt below and avoid including any additional commentary or evaluations:",
  "User Prompt: "])
prompts = ['a tiny astronaut hatching from an egg on the moon', '  Un FARO en un acantilado al atardecer, olas rompiendo  ', 'café, niño, pingüino: ¿qué tal?', ' leading space', 'word ' * 400]
cases = []
for p in prompts:
    full = tok(chi + p.lower().strip(), padding='max_length', max_length=len(tok.encode(chi)) + 298, truncation=True, add_special_tokens=True)
    ids = [i for i, m in zip(full['input_ids'], full['attention_mask']) if m]
    L = len(full['input_ids'])
    keep = [0] + [i for i in range(L - 299, L) if full['attention_mask'][i]]
    cases.append({'prompt': p, 'ids': ids, 'keep': keep})
json.dump({'what': 'Gemma tokenizer ids from the reference tokenizer at the pinned commit, for tests/unit/text-to-image.test.mjs',
           'instruction': tok.encode(chi), 'cases': cases}, open(out, 'w'))
print('cases', len(cases), 'instruction tokens', len(tok.encode(chi)))
