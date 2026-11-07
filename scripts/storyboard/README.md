# Storyboard video (reference, PyTorch)

The reference of "a video that does what you ask": a storyboard of keyframes every ~3 s with
SANA-Sprint 0.6B (text, or SDEdit from the previous keyframe or the user's photo), then the clip
between each pair with Wan 2.1 VACE 1.3B, whose 30 base blocks are swapped for the rCM few-step
ones (4 steps, no CFG, the sampler the browser already runs), the last frames of a clip carried
into the next one, stitched, and the colour pulled back to the keyframes.

    export HF_HOME=…  SB_OUT=…  SB_SANA_CACHE=…  SB_TAEHV=<dir with taehv.py>
    python -I run.py plans/fox-wakes.json --only-keyframes      # look at the keyframes first
    python -I run.py plans/fox-wakes.json --reuse-keyframes --carry 5
    python -I colormatch.py $SB_OUT/a-fox-wakes 1.0

| File | What it does |
|---|---|
| `run.py` | a plan (JSON) to keyframes, clips, the MP4 and a frame sheet with the step previews |
| `keyframes.py` | SANA-Sprint keyframes, text or SDEdit, with each step's x0 preview |
| `transitions.py` | the VACE context (known frames + mask), the rCM swap, the 4-step and the 25-step samplers, both decoders |
| `colormatch.py` | per-frame mean and spread in YCbCr moved toward the keyframes |
| `decode_check.py` | the same latents through the full VAE and the tiny decoder |
| `wan_keyframe.py` | keyframes with Wan itself (one-frame video); tried and set aside |
| `plans/` | the three test requests |

Weights: Wan-AI/Wan2.1-VACE-1.3B-diffusers (transformer, vae, text_encoder, tokenizer),
worstcoder/rcm-Wan `rCM_Wan2.1_T2V_1.3B_480p.pt`, lightx2v/Autoencoders `lighttaew2_1`,
Efficient-Large-Model/Sana_Sprint_0.6B_1024px_diffusers. All Apache-2.0.
