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
// Lo que puede pedir una herramienta: bajar o consultar un fichero de Hugging Face
// fijado a un commit (resolve/<40 hex>), de uno de sus repos, y al bajarlo decir
// cuánto mide. Nada
// más: ni vaciar el almacén, ni guardar copias, ni el diagnóstico, que lista lo
// que guardan las demás webs. Así un fallo en una de esas páginas, que abren
// ficheros del usuario, no puede llenar el almacén con lo que quiera ni borrar
// los modelos de Claw o de Code (esas webs piden la rama principal del Hub o sus
// propios servidores, y una herramienta nunca llega a esas claves).
// Repos de Hugging Face que pueden pedir las herramientas: los de registry/tasks.json de
// elffuss-ai. La línea la imprime scripts/broker-repos.mjs de ese repo, y un test de allí
// comprueba que esta copia acepta exactamente esos repos.
const REPOS_HERRAMIENTAS = /^(PaddlePaddle\/PP-OCRv6_small_det_onnx|PaddlePaddle\/PP-OCRv6_small_rec_onnx|onnx-community\/BEN2-ONNX|onnx-community\/depth-anything-v2-small|onnx-community\/rfdetr_nano-ONNX)$/;
// Ruta fijada a un commit, por segmentos que no empiezan por punto: sin «..», sin «%» y sin
// «\». La URL se normaliza al pedirla, así que «…/resolve/<sha>/../../../otro/repo/…»
// acabaría en otro repo y en otra revisión.
const HF_FIJADO = /^https:\/\/huggingface\.co\/([\w\-][\w.\-]*\/[\w\-][\w.\-]*)\/resolve\/[0-9a-f]{40}\/((?:[\w\-][\w.\-]*\/)*[\w\-][\w.\-]*)$/;
function permisoHerramienta(type, url, bytes) {
  const m = HF_FIJADO.exec(String(url ?? ''));
  if (!m || !REPOS_HERRAMIENTAS.test(m[1])) return false;
  if (type === 'elffuss-model-get') return Number.isInteger(Number(bytes)) && Number(bytes) > 0;
  return type === 'elffuss-model-has' || type === 'elffuss-model-cancel';
}
// </extract>
