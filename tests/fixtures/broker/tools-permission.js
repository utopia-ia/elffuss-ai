// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Verbatim extract of the tool-site permission of the model-store page that the
// browser tests serve (see SOURCE.json). The unit tests check it against the
// registry and the site list; the harness checks that the page it serves
// contains both blocks exactly.
// <extract>
// Las herramientas (repo elffuss-ai): el catálogo y una web por herramienta. Solo
// su nombre exacto y solo bajo elffuss.com, que es donde viven.
const HERRAMIENTAS = /^https:\/\/(tools|cutout|ocr|detect|depth)\.elffuss\.com$/;
// </extract>
// <extract>
// Lo que puede pedir una herramienta: bajar o consultar uno de los ficheros de su
// registro, fijado a su commit, diciendo su tamaño exacto. Nada más: ni otros
// ficheros u otros commits de esos repos, ni vaciar el almacén, ni guardar
// copias, ni el diagnóstico, que lista lo que guardan las demás webs. Así un fallo
// en una de esas páginas, que abren ficheros del usuario, no puede llenar el
// almacén con lo que quiera ni borrar los modelos de Claw o de Code, y tampoco
// puede curar (borrar) una copia mandando un tamaño falso: el tamaño es el de la
// lista o no hay respuesta.
// Los ficheros de las variantes de registry/tasks.json de elffuss-ai, con su tamaño.
// El bloque lo imprime scripts/broker-repos.mjs de ese repo, y un test de allí
// comprueba que esta copia es exactamente la de su registro.
const FICHEROS_HERRAMIENTAS = new Map([
  ["https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/28fe5895c24fd108c19eb3e8479f4ab385fbfc62/inference.onnx", 9880512],
  ["https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/28fe5895c24fd108c19eb3e8479f4ab385fbfc62/inference.yml", 885],
  ["https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513/inference.onnx", 21159378],
  ["https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513/inference.yml", 150579],
  ["https://huggingface.co/onnx-community/BEN2-ONNX/resolve/c552aa82688edce09f0ac9d2e31ad53d9d629010/config.json", 80],
  ["https://huggingface.co/onnx-community/BEN2-ONNX/resolve/c552aa82688edce09f0ac9d2e31ad53d9d629010/onnx/model_fp16.onnx", 219121675],
  ["https://huggingface.co/onnx-community/BEN2-ONNX/resolve/c552aa82688edce09f0ac9d2e31ad53d9d629010/preprocessor_config.json", 391],
  ["https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/config.json", 38],
  ["https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx", 99060839],
  ["https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_fp16.onnx", 49642442],
  ["https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_quantized.onnx", 27258801],
  ["https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/preprocessor_config.json", 461],
  ["https://huggingface.co/onnx-community/rfdetr_nano-ONNX/resolve/eae21cee0687a91bcf9fa071605c48d7705d2d91/config.json", 3213],
  ["https://huggingface.co/onnx-community/rfdetr_nano-ONNX/resolve/eae21cee0687a91bcf9fa071605c48d7705d2d91/onnx/model_quantized.onnx", 28826010],
  ["https://huggingface.co/onnx-community/rfdetr_nano-ONNX/resolve/eae21cee0687a91bcf9fa071605c48d7705d2d91/preprocessor_config.json", 444],
]);
function permisoHerramienta(type, url, bytes) {
  const tam = FICHEROS_HERRAMIENTAS.get(String(url ?? ''));
  if (!tam) return false;
  const dice = bytes == null || bytes === '' ? null : Number(bytes);
  if (type === 'elffuss-model-get') return dice === tam;
  if (type === 'elffuss-model-has') return dice === null || dice === tam;
  return type === 'elffuss-model-cancel';
}
// </extract>
