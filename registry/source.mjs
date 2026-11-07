// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The only hand-written part of the model registry. scripts/build-registry.mjs
// reads it, checks every repo and revision against the Hugging Face API and
// writes registry/tasks.json (sizes, hashes and licences come from the Hub,
// never from here).
//
// Per model: the task, the visible name, the base model it credits (a list when
// the model joins the work of several authors, each naming the part it is), the
// parts (Hugging Face repo pinned to a 40-hex commit), and the variants per
// backend in order of preference. `when: 'shader-f16'` means the WebGPU adapter
// must offer that feature. File references are `<part>:<path in the repo>`. A
// task's `module` is its directory under sdk/ when it is not the task's name.
//
// `node scripts/build-registry.mjs --resolve` rewrites the `revision:` lines of
// this file to the current `main` commit of each repo, read live from the Hub.

// The files every variant of Kokoro needs besides its weights: the phoneme vocabulary,
// the voices offered (Spanish, then American English) and the English phonemiser.
const KOKORO_VOICES = ['ef_dora', 'em_alex', 'em_santa', 'af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'am_puck'];
const KOKORO_SHARED = ['main:tokenizer.json', ...KOKORO_VOICES.map(v => `main:voices/${v}.bin`), 'g2p:misaki-en_us-g2p.json', 'g2p:misaki-en_us-g2p.onnx'];

export default {
  schema: 1,
  tasks: {
    'remove-bg': { default: 'remove-bg/ben2' },
    depth: { default: 'depth/depth-anything-v2-small' },
    detect: { default: 'detect/rfdetr-nano' },
    ocr: { default: 'ocr/pp-ocrv6-small' },
    'text-to-music': { default: 'text-to-music/stable-audio-3-small-music', module: 'audio' },
    'text-to-sfx': { default: 'text-to-sfx/stable-audio-3-small-sfx', module: 'audio' },
    'text-to-speech': { default: 'text-to-speech/kokoro-82m', module: 'audio' },
    'text-to-image': { default: 'text-to-image/sana-sprint-0.6b' },
    'image-to-video': { default: 'image-to-video/depth-parallax', module: 'video' },
    'text-to-video': { default: 'text-to-video/wan2.1-t2v-1.3b-rcm', module: 'video-gen' },
  },
  models: {
    'remove-bg/ben2': {
      task: 'remove-bg',
      name: { es: 'BEN2', en: 'BEN2' },
      base: { name: 'BEN2', author: 'PramaLLC', source: { hf: 'PramaLLC/BEN2' } },
      runtime: 'transformers.js',
      pipeline: 'background-removal',
      parts: {
        main: { repo: 'onnx-community/BEN2-ONNX', revision: 'c552aa82688edce09f0ac9d2e31ad53d9d629010' },
      },
      // WebGPU is left out on purpose: with ONNX Runtime Web 1.30.0 the LayerNorm
      // shader of BEN2 does not compile. The WebAssembly variant is the same file.
      devices: {
        wasm: [
          { dtype: 'fp16', files: ['main:config.json', 'main:preprocessor_config.json', 'main:onnx/model_fp16.onnx'] },
        ],
      },
      notes: { es: null, en: null },
      flag: null,
      redistributes: false,
    },
    'depth/depth-anything-v2-small': {
      task: 'depth',
      name: { es: 'Depth Anything V2 Small', en: 'Depth Anything V2 Small' },
      base: { name: 'Depth Anything V2 Small', author: 'depth-anything', source: { hf: 'depth-anything/Depth-Anything-V2-Small' } },
      runtime: 'transformers.js',
      pipeline: 'depth-estimation',
      parts: {
        main: { repo: 'onnx-community/depth-anything-v2-small', revision: '4472b7362082ad9968fee890ca0f1e5aca36b93d' },
      },
      devices: {
        webgpu: [
          { when: 'shader-f16', dtype: 'fp16', files: ['main:config.json', 'main:preprocessor_config.json', 'main:onnx/model_fp16.onnx'] },
          { dtype: 'fp32', files: ['main:config.json', 'main:preprocessor_config.json', 'main:onnx/model.onnx'] },
        ],
        wasm: [
          { dtype: 'q8', files: ['main:config.json', 'main:preprocessor_config.json', 'main:onnx/model_quantized.onnx'] },
        ],
      },
      notes: { es: null, en: null },
      flag: null,
      redistributes: false,
    },
    'detect/rfdetr-nano': {
      task: 'detect',
      name: { es: 'RF-DETR Nano', en: 'RF-DETR Nano' },
      base: { name: 'RF-DETR Nano', author: 'Roboflow', source: { github: 'roboflow/rf-detr' } },
      runtime: 'transformers.js',
      pipeline: 'object-detection',
      parts: {
        main: { repo: 'onnx-community/rfdetr_nano-ONNX', revision: 'eae21cee0687a91bcf9fa071605c48d7705d2d91' },
      },
      // WebAssembly only until a WebGPU run gives the same boxes as this one.
      devices: {
        wasm: [
          { dtype: 'q8', files: ['main:config.json', 'main:preprocessor_config.json', 'main:onnx/model_quantized.onnx'] },
        ],
      },
      notes: { es: null, en: null },
      flag: null,
      redistributes: false,
    },
    'ocr/pp-ocrv6-small': {
      task: 'ocr',
      name: { es: 'PP-OCRv6 small', en: 'PP-OCRv6 small' },
      base: { name: 'PP-OCRv6', author: 'PaddlePaddle', source: { github: 'PaddlePaddle/PaddleOCR' } },
      runtime: 'onnxruntime-web',
      pipeline: null,
      parts: {
        det: { repo: 'PaddlePaddle/PP-OCRv6_small_det_onnx', revision: '28fe5895c24fd108c19eb3e8479f4ab385fbfc62' },
        rec: { repo: 'PaddlePaddle/PP-OCRv6_small_rec_onnx', revision: 'b8f84f0b80c529de40b4fbb3544b84fa7233a513' },
      },
      devices: {
        webgpu: [
          { dtype: 'fp32', files: ['det:inference.onnx', 'det:inference.yml', 'rec:inference.onnx', 'rec:inference.yml'] },
        ],
        wasm: [
          { dtype: 'fp32', files: ['det:inference.onnx', 'det:inference.yml', 'rec:inference.onnx', 'rec:inference.yml'] },
        ],
      },
      notes: {
        es: 'El diccionario del modelo no tiene el signo «¡»: el resto de letras y signos del español sí están.',
        en: 'The model dictionary has no «¡» (inverted exclamation mark); every other Spanish letter and sign is in it.',
      },
      flag: null,
      redistributes: false,
    },
    // Stable Audio 3 Small, music and sound effects, from Stability AI's own ONNX export
    // (stable-audio-3-optimized, ungated): the T5Gemma text encoder (fp16), the DiT of each
    // model (fp16 with fp32 islands, conditioning baked in) and the SAME-S decoder in fp32
    // with the reference limiter in place of the hard clip. The fp16 graphs need WebGPU with
    // shader-f16; on WebAssembly one step takes too long to offer. The model pages
    // (stabilityai/stable-audio-3-small-*) are gated: only their licence is read there.
    'text-to-music/stable-audio-3-small-music': {
      task: 'text-to-music',
      name: { es: 'Stable Audio 3 Small Music', en: 'Stable Audio 3 Small Music' },
      base: { name: 'Stable Audio 3 Small Music', author: 'Stability AI', source: { hf: 'stabilityai/stable-audio-3-small-music', gatedPage: true } },
      accept: ['stable-audio-community'],
      terms: [
        { name: 'Stability AI Community License', url: 'https://stability.ai/license', file: 'LICENSES/Stability-AI-Community-License.md' },
        { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms', file: 'LICENSES/Gemma-Terms-of-Use.md', scope: 'onnx/t5gemma/encoder.onnx' },
      ],
      runtime: 'onnxruntime-web',
      pipeline: null,
      parts: {
        sa3: { repo: 'stabilityai/stable-audio-3-optimized', revision: '30cb2644da54bfa63275d1bc7f1fa67fc718680f', only: 'used' },
      },
      devices: {
        webgpu: [
          { when: 'shader-f16', dtype: 'fp16', files: ['sa3:tokenizer.model', 'sa3:onnx/t5gemma/encoder.onnx', 'sa3:onnx/sa3-sm-music/dit_fp16.onnx', 'sa3:onnx/same-s/dec_bf16_limiter.onnx'] },
        ],
      },
      notes: {
        es: 'El modelo entiende descripciones en inglés: género, instrumentos, ambiente y tempo (por ejemplo «120 BPM»). Hace música instrumental, sin voces inteligibles.',
        en: 'The model understands descriptions in English: genre, instruments, mood and tempo (for example "120 BPM"). It makes instrumental music, without intelligible vocals.',
      },
      flag: null,
      redistributes: false,
    },
    'text-to-sfx/stable-audio-3-small-sfx': {
      task: 'text-to-sfx',
      name: { es: 'Stable Audio 3 Small SFX', en: 'Stable Audio 3 Small SFX' },
      base: { name: 'Stable Audio 3 Small SFX', author: 'Stability AI', source: { hf: 'stabilityai/stable-audio-3-small-sfx', gatedPage: true } },
      accept: ['stable-audio-community'],
      terms: [
        { name: 'Stability AI Community License', url: 'https://stability.ai/license', file: 'LICENSES/Stability-AI-Community-License.md' },
        { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms', file: 'LICENSES/Gemma-Terms-of-Use.md', scope: 'onnx/t5gemma/encoder.onnx' },
      ],
      runtime: 'onnxruntime-web',
      pipeline: null,
      parts: {
        sa3: { repo: 'stabilityai/stable-audio-3-optimized', revision: '30cb2644da54bfa63275d1bc7f1fa67fc718680f', only: 'used' },
      },
      devices: {
        webgpu: [
          { when: 'shader-f16', dtype: 'fp16', files: ['sa3:tokenizer.model', 'sa3:onnx/t5gemma/encoder.onnx', 'sa3:onnx/sa3-sm-sfx/dit_fp16.onnx', 'sa3:onnx/same-s/dec_bf16_limiter.onnx'] },
        ],
      },
      notes: {
        es: 'El modelo entiende descripciones en inglés: qué suena, cómo y dónde (por ejemplo «una puerta de madera que se cierra de golpe en un pasillo de piedra»).',
        en: 'The model understands descriptions in English: what makes the sound, how and where (for example "a wooden door slamming shut in a stone hallway").',
      },
      flag: null,
      redistributes: false,
    },
    // Kokoro 82M in the ONNX export of onnx-community (fp32 on WebGPU, q8 on WebAssembly),
    // a curated set of its Spanish and American English voices, and for English the misaki
    // word lists with their small fallback network, packaged for ONNX Runtime alone (no
    // eSpeak NG). Spanish is phonemised by rules in sdk/audio/g2p-es.js.
    'text-to-speech/kokoro-82m': {
      task: 'text-to-speech',
      name: { es: 'Kokoro 82M', en: 'Kokoro 82M' },
      base: { name: 'Kokoro 82M', author: 'hexgrad', source: { hf: 'hexgrad/Kokoro-82M' } },
      runtime: 'onnxruntime-web',
      pipeline: null,
      parts: {
        main: { repo: 'onnx-community/Kokoro-82M-v1.0-ONNX', revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231', only: 'used' },
        g2p: { repo: 'nekwo/misaki-en-us-g2p-onnx', revision: '4b3a605d2f605318ab4f762ab9855c44106528b7', only: 'used' },
      },
      devices: {
        webgpu: [
          { dtype: 'fp32', files: ['main:onnx/model.onnx', ...KOKORO_SHARED] },
        ],
        wasm: [
          { dtype: 'q8', files: ['main:onnx/model_quantized.onnx', ...KOKORO_SHARED] },
        ],
      },
      notes: { es: null, en: null },
      flag: null,
      redistributes: false,
    },
    'text-to-image/sana-sprint-0.6b': {
      task: 'text-to-image',
      name: { es: 'SANA-Sprint 0.6B', en: 'SANA-Sprint 0.6B' },
      base: { name: 'SANA-Sprint 0.6B', author: 'NVlabs', source: { hf: 'Efficient-Large-Model/Sana_Sprint_0.6B_1024px' } },
      runtime: 'onnxruntime-web',
      pipeline: null,
      // `main`, the original repository: the tokenizer and the configuration files.
      // `onnx`, the conversion of its weights for the browser (UtopiaIA): no ONNX
      // export of this model or of a 4-bit Gemma 2 encoder that gives its hidden
      // states exists on the Hub. Published by UtopiaIA at the pinned commit.
      parts: {
        main: { repo: 'Efficient-Large-Model/Sana_Sprint_0.6B_1024px_diffusers', revision: 'aa76e7f4f4928f378716b6716a2130fba3caf5b1' },
        onnx: { repo: 'UtopiaIA/sana-sprint-0.6b-1024px-onnx-web', revision: '762399d3a10e6ec06afeffbdf7dd425c83004fb3' },
      },
      // WebGPU only, with float16 shaders: the transformer and the decoder are float16,
      // and the 4-bit text model needs WebGPU's speed for its prompt.
      devices: {
        webgpu: [
          {
            when: 'shader-f16',
            dtype: 'q4f16',
            files: [
              'main:tokenizer/tokenizer.json', 'main:tokenizer/tokenizer_config.json', 'main:transformer/config.json',
              'main:vae/config.json', 'main:scheduler/scheduler_config.json',
              'onnx:text_encoder/model_q4.onnx', 'onnx:text_encoder/embed_tokens_q4.bin', 'onnx:text_encoder/embed_tokens_q4_scales.bin',
              'onnx:transformer/model_fp16.onnx', 'onnx:vae_decoder/model_fp16.onnx',
            ],
          },
        ],
      },
      notes: {
        es: 'Entiende mejor las descripciones en inglés.',
        en: 'It understands descriptions in English best.',
      },
      // The text encoder is Gemma 2 2B IT, under the Gemma Terms of Use, inside an
      // Apache-2.0 model, as in the original repository.
      flag: 'gemma-terms',
      redistributes: true,
    },
    // A video from one photo: Depth Anything V2 Small gives the depth (the same
    // files, at the same commit, as depth/depth-anything-v2-small, so the store
    // keeps them once), and MI-GAN paints what is hidden behind what is near. The
    // camera, the layers and the video itself are code, not models.
    'image-to-video/depth-parallax': {
      task: 'image-to-video',
      name: { es: 'Depth Anything V2 Small y MI-GAN', en: 'Depth Anything V2 Small and MI-GAN' },
      base: [
        { name: 'Depth Anything V2 Small', author: 'depth-anything', source: { hf: 'depth-anything/Depth-Anything-V2-Small' }, part: 'depth' },
        { name: 'MI-GAN', author: 'Picsart AI Research', source: { github: 'Picsart-AI-Research/MI-GAN' }, part: 'inpaint' },
      ],
      runtime: 'onnxruntime-web',
      pipeline: null,
      parts: {
        depth: { repo: 'onnx-community/depth-anything-v2-small', revision: '4472b7362082ad9968fee890ca0f1e5aca36b93d' },
        inpaint: { repo: 'andraniksargsyan/migan', revision: '406830d0fa60666da0071c342ad2fbc8f30c5c64' },
      },
      // The depth variants follow depth/depth-anything-v2-small; MI-GAN has one file.
      devices: {
        webgpu: [
          { when: 'shader-f16', dtype: 'fp16', files: ['depth:preprocessor_config.json', 'depth:onnx/model_fp16.onnx', 'inpaint:migan.onnx'] },
          { dtype: 'fp32', files: ['depth:preprocessor_config.json', 'depth:onnx/model.onnx', 'inpaint:migan.onnx'] },
        ],
        wasm: [
          { dtype: 'q8', files: ['depth:preprocessor_config.json', 'depth:onnx/model_quantized.onnx', 'inpaint:migan.onnx'] },
        ],
      },
      notes: {
        es: 'Dos modelos: la profundidad de la foto y el fondo que queda detrás de lo que está cerca. La cámara y el vídeo los hace el código.',
        en: 'Two models: the depth of the photo, and the background hidden behind what is near. The camera and the video are made by code.',
      },
      flag: null,
      redistributes: false,
    },
    // A video from a text: Wan 2.1 T2V 1.3B with the few-step rCM student and the
    // light TAEHV decoder, converted by UtopiaIA for the browser (scripts/wan/): the
    // text encoder (UMT5-XXL) in 4 bits and in four shards, the transformer in 8
    // bits in three, and the decoder. No such conversion exists on the Hub. The
    // tokenizer is read from the original repository. WebGPU with float16 shaders.
    'text-to-video/wan2.1-t2v-1.3b-rcm': {
      task: 'text-to-video',
      name: { es: 'Wan 2.1 T2V 1.3B (rCM, 4 pasos)', en: 'Wan 2.1 T2V 1.3B (rCM, 4 steps)' },
      base: [
        { name: 'Wan2.1-T2V-1.3B', author: 'Wan-AI', source: { hf: 'Wan-AI/Wan2.1-T2V-1.3B' }, part: 'tok' },
        { name: 'rCM Wan2.1 T2V 1.3B 480p', author: 'worstcoder (rCM, NVlabs/Tsinghua)', source: { hf: 'worstcoder/rcm-Wan' }, part: 'web' },
        { name: 'lighttaew2_1 (TAEHV)', author: 'lightx2v / madebyollin', source: { hf: 'lightx2v/Autoencoders' }, part: 'web' },
      ],
      runtime: 'onnxruntime-web',
      pipeline: null,
      sampler: 'rcm',
      parts: {
        tok: { repo: 'Wan-AI/Wan2.1-T2V-1.3B', revision: '37ec512624d61f7aa208f7ea8140a131f93afc9a' },
        web: { repo: 'UtopiaIA/Wan2.1-T2V-1.3B-web', revision: '3dbd66ddf838b03a751576500ed6b5e72c53a972' },
      },
      devices: {
        webgpu: [
          {
            when: 'shader-f16',
            dtype: 'q8f16',
            files: [
              'tok:google/umt5-xxl/tokenizer.json',
              'web:dit/ctx.onnx', 'web:dit/part0.onnx', 'web:dit/part1.onnx', 'web:dit/part2.onnx',
              'web:t5/embed_q4.bin',
              'web:t5/encoder_0.onnx', 'web:t5/encoder_1.onnx', 'web:t5/encoder_2.onnx', 'web:t5/encoder_3.onnx',
              'web:vae/taew2_1_light.onnx',
            ],
          },
        ],
      },
      notes: {
        es: 'El codificador de texto va en 4 bits y el transformador en 8 bits: el vídeo de una semilla no es el mismo que el del modelo original, pero sigue la descripción igual de bien.',
        en: 'The text encoder runs in 4 bits and the transformer in 8 bits: the video of a seed is not the one of the original model, but it follows the prompt as well.',
      },
      flag: null,
      redistributes: true,
    },
  },
};
