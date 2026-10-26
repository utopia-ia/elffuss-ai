// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The OCR models' settings and character list, read from their inference.yml:
// the YAML subset those files use, the detector's thresholds and normalisation,
// the recogniser's input and decoder, and the dictionary with every quoting
// YAML gives single characters (including the ideographic space, which is not
// white space for YAML).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, yamlScalar, unescapeDouble, parseDetConfig, parseRecConfig, parseScale } from '../../sdk/ocr/config.js';
import { parseCharacterDict, ctcVocabulary, checkClasses, unquoteItem } from '../../sdk/ocr/dict.js';

// Shaped like the pinned detection file (values of our own).
const DET = `Global:
  model_name: test_det
Hpi:
  backend_configs:
    paddle_infer:
      trt_dynamic_shapes: &id001
        x:
        - - 1
          - 3
          - 32
        - - 1
          - 3
          - 4000
    tensorrt:
      dynamic_shapes: *id001
PostProcess:
  box_thresh: 0.45
  max_candidates: 3000
  name: DBPostProcess
  thresh: 0.2
  unclip_ratio: 1.4
PreProcess:
  transform_ops:
  - DecodeImage:
      channel_first: false
      img_mode: BGR
  - DetLabelEncode: null
  - NormalizeImage:
      mean:
      - 0.485
      - 0.456
      - 0.406
      order: hwc
      scale: 1./255.
      std:
      - 0.229
      - 0.224
      - 0.225
  - ToCHWImage: null
`;

const dictItems = ["'!'", "'\"'", "'#'", '$', "''''", '(', "':'", '\\', "'0'", 'A', 'a', 'ñ', 'Ñ', '¿', '«', '»', '€', 'º', '　', '"\\x85"', '"\\u2028"', "'-'", "'~'"];
const expectedChars = ['!', '"', '#', '$', "'", '(', ':', '\\', '0', 'A', 'a', 'ñ', 'Ñ', '¿', '«', '»', '€', 'º', '　', '\u0085', ' ', '-', '~'];
const filler = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x4e00 + i));
const REC = `Global:
  model_name: test_rec
PreProcess:
  transform_ops:
  - DecodeImage:
      channel_first: false
      img_mode: BGR
  - RecResizeImg:
      image_shape:
      - 3
      - 48
      - 320
  - KeepKeys:
      keep_keys:
      - image
PostProcess:
  name: CTCLabelDecode
  character_dict:
${[...dictItems, ...filler].map(c => `  - ${c}`).join('\n')}
`;

test('YAML: mappings, sequences at the same indentation, nested sequences, anchors and aliases', () => {
  const y = parseYaml(DET);
  assert.equal(y.Global.model_name, 'test_det');
  assert.deepEqual(y.Hpi.backend_configs.paddle_infer.trt_dynamic_shapes.x, [[1, 3, 32], [1, 3, 4000]]);
  assert.deepEqual(y.Hpi.backend_configs.tensorrt.dynamic_shapes, y.Hpi.backend_configs.paddle_infer.trt_dynamic_shapes);
  assert.equal(y.PreProcess.transform_ops.length, 4);
  assert.deepEqual(y.PreProcess.transform_ops[1], { DetLabelEncode: null });
  assert.deepEqual(y.PreProcess.transform_ops[2].NormalizeImage.mean, [0.485, 0.456, 0.406]);
  assert.equal(y.PreProcess.transform_ops[2].NormalizeImage.scale, '1./255.');
});

test('YAML: scalars, quotes, escapes and comments', () => {
  assert.equal(yamlScalar("'it''s'"), "it's");
  assert.equal(yamlScalar('"a\\tb\\u00f1\\x41\\\\"'), 'a\tbñA\\');
  assert.equal(yamlScalar('~'), null);
  assert.equal(yamlScalar('null'), null);
  assert.equal(yamlScalar('true'), true);
  assert.equal(yamlScalar('12'), 12);
  assert.equal(yamlScalar('-0.5e1'), -5);
  assert.equal(yamlScalar('1./255.'), '1./255.');
  assert.equal(yamlScalar('　'), '　', 'only spaces and tabs are trimmed');
  assert.equal(unescapeDouble('\\N\\_\\L\\P\\e'), '\u0085   \x1b');
  assert.throws(() => unescapeDouble('\\q'), SyntaxError);
  assert.throws(() => yamlScalar("'open"), SyntaxError);
  assert.deepEqual(parseYaml("a: 1 # note\nb: '# not a comment'\n# a comment line\nc:\n- x # trailing\n"), { a: 1, b: '# not a comment', c: ['x'] });
  assert.deepEqual(parseYaml('k: []\nm: {}\n'), { k: [], m: {} });
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), SyntaxError);
  assert.throws(() => parseYaml('a: *nope\n'), SyntaxError);
});

test('detection settings come from the file, with the resize rule of PP-OCR', () => {
  const c = parseDetConfig(DET);
  assert.deepEqual({ ...c, mean: [...c.mean], std: [...c.std] }, {
    thresh: 0.2, boxThresh: 0.45, maxCandidates: 3000, unclipRatio: 1.4,
    mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], scale: 1 / 255, bgr: true,
    limitSideLen: 736, maxSideLimit: 4000, multiple: 32, minSize: 3,
  });
  assert.equal(parseDetConfig(DET.replace('img_mode: BGR', 'img_mode: RGB')).bgr, false);
  assert.throws(() => parseDetConfig(DET.replace('DBPostProcess', 'EASTPostProcess')), e => e.code === 'model-mismatch');
  assert.throws(() => parseDetConfig(DET.replace('thresh: 0.2', 'thresh: 3')), e => e.code === 'model-mismatch');
  assert.throws(() => parseDetConfig(DET.replace('  - 0.406\n', '')), e => e.code === 'model-mismatch');
  assert.throws(() => parseDetConfig('a: [1'), e => e.code === 'model-mismatch');
  assert.equal(parseScale('1./255.'), 1 / 255);
  assert.equal(parseScale(0.5), 0.5);
  assert.throws(() => parseScale('eval(1)'), e => e.code === 'model-mismatch');
});

test('recognition settings: height 48, base width 320, BGR, CTC', () => {
  assert.deepEqual({ ...parseRecConfig(REC) }, { height: 48, width: 320, maxWidth: 3200, bgr: true });
  assert.throws(() => parseRecConfig(REC.replace('CTCLabelDecode', 'AttnLabelDecode')), e => e.code === 'model-mismatch');
  assert.throws(() => parseRecConfig(REC.replace('      - 3\n      - 48', '      - 1\n      - 48')), e => e.code === 'model-mismatch');
});

test('the dictionary: every YAML quoting of one character, in order', () => {
  const chars = parseCharacterDict(REC);
  assert.deepEqual(chars.slice(0, expectedChars.length), expectedChars);
  assert.equal(chars.length, expectedChars.length + filler.length);
  // The generic reader agrees, item by item.
  assert.deepEqual(parseYaml(REC).PostProcess.character_dict.map(String).slice(0, 9), expectedChars.slice(0, 9));
  assert.equal(unquoteItem("''"), '');
  assert.equal(unquoteItem("'a''b'"), "a'b");
});

test('the dictionary ends at the next key and refuses what is not a list of characters', () => {
  const withKey = REC.replace('  character_dict:', '  character_dict:') + '  other: 1\n';
  assert.equal(parseCharacterDict(withKey).length, expectedChars.length + filler.length);
  assert.throws(() => parseCharacterDict('PostProcess:\n  name: CTCLabelDecode\n'), e => e.code === 'model-mismatch');
  assert.throws(() => parseCharacterDict(REC.replace(`  - ${filler[5]}\n`, '  - ab\n')), e => e.code === 'model-mismatch');
  assert.throws(() => parseCharacterDict('character_dict:\n- a\n- b\n'), e => e.code === 'model-mismatch', 'too short to be a recogniser');
});

test('CTC classes: blank, the characters, a space; the model must have exactly that many', () => {
  const v = ctcVocabulary(['a', 'b']);
  assert.deepEqual(v, ['', 'a', 'b', ' ']);
  assert.doesNotThrow(() => checkClasses(4, v));
  assert.throws(() => checkClasses(18710, v), e => e.code === 'model-mismatch' && e.details.classes === 18710);
});
