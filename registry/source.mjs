// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The only hand-written part of the model registry. scripts/build-registry.mjs
// reads it, checks every repo and revision against the Hugging Face API and
// writes registry/tasks.json (sizes, hashes and licences come from the Hub,
// never from here).
//
// Per model: the task, the visible name, the base model it credits, the parts
// (Hugging Face repo pinned to a 40-hex commit), and the variants per backend in
// order of preference. `when: 'shader-f16'` means the WebGPU adapter must offer
// that feature. File references are `<part>:<path in the repo>`.
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
  },
};
