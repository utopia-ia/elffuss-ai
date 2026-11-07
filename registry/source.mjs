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

export default {
  schema: 1,
  tasks: {
    'remove-bg': { default: 'remove-bg/ben2' },
    depth: { default: 'depth/depth-anything-v2-small' },
    detect: { default: 'detect/rfdetr-nano' },
    ocr: { default: 'ocr/pp-ocrv6-small' },
    'text-to-image': { default: 'text-to-image/sana-sprint-0.6b' },
    'image-to-video': { default: 'image-to-video/depth-parallax', module: 'video' },
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
    'text-to-image/sana-sprint-0.6b': {
      task: 'text-to-image',
      name: { es: 'SANA-Sprint 0.6B', en: 'SANA-Sprint 0.6B' },
      base: { name: 'SANA-Sprint 0.6B', author: 'NVlabs', source: { hf: 'Efficient-Large-Model/Sana_Sprint_0.6B_1024px' } },
      runtime: 'onnxruntime-web',
      pipeline: null,
      // `main`, the original repository: the tokenizer and the configuration files.
      // `onnx`, the conversion of its weights for the browser (UtopiaIA): no ONNX
      // export of this model or of a 4-bit Gemma 2 encoder that gives its hidden
      // states exists on the Hub. Prepared, not pushed yet: see deploy/DEPLOY.md.
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
  },
};
