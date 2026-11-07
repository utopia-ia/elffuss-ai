// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The audio task's pure helpers: seeded noise, the sampler's schedule and step,
// WAV in and out, waveform and joins, the SentencePiece tokenizer of T5Gemma, the
// numbers, the Spanish phonemiser against eSpeak NG, the English one over a small
// word list, sentence splitting and chunking, Kokoro's ids and styles, MOSS-TTS-Nano's
// rows, frame inputs and chunks against its official runtime, and the options of
// every task. With ELFFUSS_AI_CACHE set and the weights cached, the
// tokenizer is also checked with the real tokenizer.model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRng, isSeed, MAX_SEED, randomSeed } from '../../sdk/audio/rng.js';
import { latentLength, decoderLength, schedule, logsnrShift, pingpongStep, pcmToChannels, SAMPLE_RATE } from '../../sdk/audio/sampler.js';
import { encodeWav, decodeWav } from '../../sdk/audio/wav.js';
import { peaks, fadeIn, fadeOut, measure, soundBounds, joinSpeech } from '../../sdk/audio/signal.js';
import { parseModel, createTokenizer, encodeFixed, nmtNfkc } from '../../sdk/audio/spm.js';
import { spanishNumber, englishNumber, englishOrdinal, englishYear, spellNumbers, parseNumber } from '../../sdk/audio/numbers.js';
import { spanishToPhonemes } from '../../sdk/audio/g2p-es.js';
import { createEnglish, englishToPhonemes, applyStress } from '../../sdk/audio/g2p-en.js';
import { sentences, packChunks, cutPhonemes, MAX_PHONEMES } from '../../sdk/audio/text.js';
import { VOICES, DEFAULT_VOICE, readVocab, phonemeIds, styleFor, voiceInfo } from '../../sdk/audio/kokoro.js';
import { normalizeInput, DURATION } from '../../sdk/audio/stable-audio.js';
import { normalizeSpeech } from '../../sdk/audio/speech.impl.js';
import * as api from '../../sdk/audio/index.js';
import * as moss from '../../sdk/audio/moss.js';
import * as mossImpl from '../../sdk/audio/speech-moss.impl.js';
import { createHash } from 'node:crypto';
import { doubleScalarsToInt64 } from '../../sdk/audio/graph-patch.js';
import { hashFile } from '../../scripts/fetch-weights.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url), 'utf8'));
const reg = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
const MOSS_MANIFEST = fixture('moss-frames.json').manifest;

test('seeded noise: the same seed gives the same numbers, another seed others; normals look normal', () => {
  const a = createRng(42).fillNormal(new Float32Array(50000)), b = createRng(42).fillNormal(new Float32Array(50000));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.slice(0, 10), createRng(43).fillNormal(new Float32Array(10)));
  let m = 0, v = 0;
  for (const x of a) m += x;
  m /= a.length;
  for (const x of a) v += (x - m) ** 2;
  v /= a.length;
  assert.ok(Math.abs(m) < 0.02 && Math.abs(v - 1) < 0.03, `mean ${m}, variance ${v}`);
  const u = createRng(1);
  for (let i = 0; i < 1000; i++) { const x = u.uniform(); assert.ok(x >= 0 && x < 1); }
  assert.ok(isSeed(0) && isSeed(MAX_SEED) && !isSeed(-1) && !isSeed(1.5) && !isSeed(MAX_SEED + 1));
  assert.ok(isSeed(randomSeed()));
});

test('sampler: latent length, even decoder length, schedule of Stable Audio 3 and one ping-pong step', () => {
  assert.equal(latentLength(10), 108);
  assert.equal(latentLength(0.01), 1);
  assert.equal(latentLength(30), Math.ceil(30 * 44100 / 4096));
  assert.equal(decoderLength(107), 108);
  assert.equal(decoderLength(108), 108);
  // The schedule the reference pipeline printed for 8 steps.
  const ref = [1.0, 0.9944, 0.9845, 0.9579, 0.8909, 0.7455, 0.5125, 0.2739, 0.0];
  schedule(8).forEach((v, i) => assert.ok(Math.abs(v - ref[i]) < 1e-4, `step ${i}: ${v}`));
  assert.equal(logsnrShift(0), 0);
  assert.equal(logsnrShift(1), 1);
  assert.throws(() => schedule(0), RangeError);
  const x = new Float32Array([1, 2]), v = new Float32Array([0.5, 1]), n = new Float32Array([10, 20]);
  pingpongStep(x, v, 0.5, 0.25, n);
  // denoised = x - 0.5 v = [0.75, 1.5]; x = 0.75 d + 0.25 n
  assert.deepEqual([...x], [0.75 * 0.75 + 2.5, 0.75 * 1.5 + 5]);
  const y = new Float32Array([1, 2]);
  pingpongStep(y, v, 0.5, 0, null);
  assert.deepEqual([...y], [0.75, 1.5], 'the last step keeps the denoised latent');
  const pcm = Int32Array.from([32767, -32767, 0, 16384, 1, 2]);
  const ch = pcmToChannels(pcm, 2);
  assert.deepEqual([...ch[0]].map(v => Math.round(v * 1e4)), [10000, 0]);
  assert.deepEqual([...ch[1]].map(v => Math.round(v * 1e4)), [-10000, 5000]);
});

test('WAV: 16-bit and float files read back, with their rate and channels', () => {
  const l = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.8);
  const r = Float32Array.from(l, v => -v);
  const buf = encodeWav([l, r], 44100);
  assert.equal(buf.byteLength, 44 + 1000 * 4);
  const back = decodeWav(buf);
  assert.equal(back.sampleRate, 44100);
  assert.equal(back.channels.length, 2);
  assert.ok(back.channels[0].every((v, i) => Math.abs(v - l[i]) < 1 / 16000));
  const f = decodeWav(encodeWav([l], 24000, { float: true }));
  assert.equal(f.sampleRate, 24000);
  assert.deepEqual(f.channels[0], l);
  const clipped = decodeWav(encodeWav([Float32Array.from([2, -2, NaN])], 8000)).channels[0];
  assert.deepEqual([...clipped].map(v => Math.round(v * 32768)), [32767, -32767, 0]);
  assert.throws(() => decodeWav(new ArrayBuffer(8)), TypeError);
  assert.throws(() => encodeWav([new Float32Array(2), new Float32Array(3)], 8000), RangeError);
});

test('waveform peaks, fades without a jump, measures, and speech joined without clicks', () => {
  const s = Float32Array.from({ length: 800 }, (_, i) => (i < 400 ? 0.5 : -0.25));
  const p = peaks([s], 2);
  assert.deepEqual([...p], [0, 0.5, -0.25, 0]);
  const c = new Float32Array(100).fill(1);
  fadeIn(c, 10); fadeOut(c, 10);
  assert.equal(c[0], 0);
  assert.ok(Math.abs(c.at(-1)) < 0.03 && c[50] === 1);
  const m = measure([Float32Array.from([1, -1, 0, 0])], 4);
  assert.equal(m.peakDb, 0);
  assert.equal(m.clipped, 0.5);
  const quiet = new Float32Array(24000);
  // A tone that rises and falls smoothly: any step in the join is the join's.
  const tone = Float32Array.from({ length: 24000 }, (_, i) => (i > 6000 && i < 18000 ? Math.sin(i / 5) * 0.5 * Math.sin((Math.PI * (i - 6000)) / 12000) : 0));
  assert.deepEqual(soundBounds(quiet, 24000), [0, 0]);
  const [a, b] = soundBounds(tone, 24000);
  assert.ok(a <= 6100 && a > 5500 && b >= 17900 && b < 18500, `${a} ${b}`);
  const joined = joinSpeech([{ samples: tone, pause: 0.3 }, { samples: tone, pause: 0.3 }], 24000);
  // Two tones of half a second, each with its margin on both sides and the pause between, no step at any edge.
  assert.ok(Math.abs(joined.length / 24000 - (2 * (0.5 + 0.08) + 0.3)) < 0.03, String(joined.length / 24000));
  let jump = 0;
  for (let i = 1; i < joined.length; i++) jump = Math.max(jump, Math.abs(joined[i] - joined[i - 1]));
  assert.ok(jump <= 0.1, `largest step between samples ${jump}`);
  assert.equal(joined[0], 0);
});

/** A tiny SentencePiece model, written as protobuf by hand. */
function tinyModel(pieces) {
  const bytes = [];
  const varint = v => { while (v > 127) { bytes.push((v & 127) | 128); v >>>= 7; } bytes.push(v); };
  for (const [piece, score, type] of pieces) {
    const p = new TextEncoder().encode(piece);
    const body = [];
    const push = (...b) => body.push(...b);
    push(0x0a, p.length, ...p);
    const f = new Uint8Array(new Float32Array([score]).buffer);
    push(0x15, ...f);
    push(0x18, type);
    bytes.push(0x0a); varint(body.length); bytes.push(...body);
  }
  return new Uint8Array(bytes);
}

test('SentencePiece: pieces read from protobuf, highest-score merges first, user symbols whole, bytes as fallback', () => {
  const model = tinyModel([['<pad>', 0, 3], ['<eos>', 0, 3], ['<bos>', 0, 3], ['<unk>', 0, 2], ['<mask>', 0, 4],
    ['<0xC3>', 0, 6], ['<0xB1>', 0, 6], ['a', -10, 1], ['b', -10, 1], ['▁', -10, 1], ['ab', -1, 1], ['▁ab', -2, 1], ['bb', -0.5, 1]]);
  const pieces = parseModel(model);
  assert.equal(pieces.length, 13);
  assert.equal(pieces[10].piece, 'ab');
  const tok = createTokenizer(pieces);
  assert.deepEqual(tok.encode('ab ab'), [10, 11]);
  assert.deepEqual(tok.encode('abb'), [7, 12], '"bb" scores higher than "ab"');
  assert.deepEqual(tok.encode('a<mask>b'), [7, 4, 8]);
  assert.deepEqual(tok.encode('ñ'), [5, 6], 'UTF-8 bytes when there is no piece');
  const fixed = encodeFixed(tok, 'ab ab', 4);
  assert.deepEqual([...fixed.ids], [10n, 11n, 0n, 0n]);
  assert.deepEqual([...fixed.mask], [1n, 1n, 0n, 0n]);
  assert.equal(encodeFixed(tok, 'a b a b a', 2).truncated, true);
  assert.throws(() => parseModel(new Uint8Array([0x08, 0x01])), TypeError);
});

test('SentencePiece: the ids of T5Gemma\'s tokenizer.model are those of SentencePiece itself (with the weight cache)', async t => {
  const cache = process.env.ELFFUSS_AI_CACHE;
  const m = reg.models['text-to-music/stable-audio-3-small-music'].parts.sa3;
  const file = cache && join(cache, 'hf', ...m.repo.split('/'), m.revision, 'tokenizer.model');
  if (!file || !existsSync(file)) { t.skip('no weight cache'); return; }
  assert.equal(await hashFile(file, m.files['tokenizer.model']), m.files['tokenizer.model'].sha256);
  const tok = createTokenizer(parseModel(readFileSync(file)));
  const { cases } = fixture('spm-ids.json');
  assert.ok(cases.length > 50);
  for (const [text, ids] of cases) assert.deepEqual(tok.encode(text), ids, JSON.stringify(text));
});

test('numbers in words, Spanish and English', () => {
  assert.equal(spanishNumber(0), 'cero');
  assert.equal(spanishNumber(21), 'veintiuno');
  assert.equal(spanishNumber(100), 'cien');
  assert.equal(spanishNumber(115), 'ciento quince');
  assert.equal(spanishNumber(1999), 'mil novecientos noventa y nueve');
  assert.equal(spanishNumber(21000), 'veintiún mil');
  assert.equal(spanishNumber(31000), 'treinta y un mil');
  assert.equal(spanishNumber(2_000_000), 'dos millones');
  assert.equal(spanishNumber(1_000_001), 'un millón uno');
  assert.equal(englishNumber(1250), 'one thousand two hundred and fifty');
  assert.equal(englishNumber(42), 'forty-two');
  assert.equal(englishOrdinal(21), 'twenty-first');
  assert.equal(englishOrdinal(12), 'twelfth');
  assert.equal(englishYear(1984), 'nineteen eighty-four');
  assert.equal(englishYear(2005), 'two thousand and five');
  assert.equal(parseNumber('1.234,5', true), 1234.5);
  assert.equal(parseNumber('1,234.5', false), 1234.5);
  assert.equal(spellNumbers('Tengo 25 años y 3,5 €.', 'es'), 'Tengo veinticinco años y tres coma cinco euros.');
  assert.equal(spellNumbers('It costs $20.', 'en'), 'It costs twenty dollars.');
  assert.equal(spellNumbers('50% off on the 1st', 'en'), 'fifty percent off on the first');
  assert.equal(spellNumbers('el 1.º y la 2.ª', 'es'), 'el primero y la segunda');
});

test('Spanish phonemes: close to eSpeak NG, the phonemiser Kokoro learnt from', () => {
  const { cases } = fixture('es-espeak.json');
  const lev = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  let exact = 0, errors = 0, chars = 0;
  for (const [src, want] of cases) {
    const w = [...want.replace(/[¡¿]/g, '').replace(/\s+/g, ' ').trim()];
    const got = [...spanishToPhonemes(src)];
    const e = lev(got, w);
    errors += e; chars += w.length; if (!e) exact++;
  }
  // Measured 94 of 105 exact and 1.1 % of phonemes off (open e, a few hiatus); the bar has a margin.
  assert.ok(exact / cases.length >= 0.85, `exact ${exact}/${cases.length}`);
  assert.ok(errors / chars <= 0.02, `phoneme error rate ${(100 * errors / chars).toFixed(2)} %`);
  assert.equal(spanishToPhonemes('Hola, ¿qué tal estás?'), 'ˈola, kˈe tˈal estˈas?');
  assert.equal(spanishToPhonemes('El perro de San Roque.'), 'el pˈero ðe sˈan rˈoke.');
});

test('English phonemes over misaki\'s rules: lists, endings, acronyms, context words, the fallback for the rest', async () => {
  const en = createEnglish({
    gold: { hello: 'həlˈO', world: 'wˈɜɹld', to: 'tˈu', play: 'plˈA', sing: 'sˈɪŋ', apple: 'ˈæpᵊl', G: 'ʤˈi', P: 'pˈi', U: 'jˈu', read: { DEFAULT: 'ɹˈid', VBD: 'ɹˈɛd' }, wait: 'wˈAt', it: 'ɪt' },
    silver: { browser: 'bɹˈWzəɹ' },
  });
  const asked = [];
  const ps = async t => englishToPhonemes(en, t, async w => { asked.push(w); return 'kəkˈɔɹO'; });
  assert.equal(await ps('Hello, world!'), 'həlˈO, wˈɜɹld!');
  assert.equal(await ps('to play'), 'tə plˈA', '"to" before a consonant');
  assert.equal(await ps('to apple'), 'tʊ ˈæpᵊl', '"to" before a vowel');
  assert.equal(await ps('the apple the world'), 'ði ˈæpᵊl ðə wˈɜɹld');
  assert.equal(await ps('played singing plays'), 'plˈAd sˈɪŋɪŋ plˈAz');
  assert.equal(await ps('waited'), 'wˈAɾᵻd'.replace('ɾ', 'T'), 'a flap is written T for Kokoro 1.0');
  assert.equal(await ps('PUG'), 'pˌijˌuʤˈi', 'letters read one by one');
  assert.equal(await ps('read it'), 'ɹˈid ɪt', 'without tags, the default reading');
  assert.equal(await ps('Kokoro browser'), 'kəkˈɔɹO bɹˈWzəɹ');
  assert.deepEqual(asked, ['Kokoro']);
  assert.equal(applyStress('ɹˈid', -1), 'ɹˌid');
  assert.equal(applyStress('ɹid', 2), 'ɹˈid');
});

test('sentences, their pauses, and chunks within Kokoro\'s limit', () => {
  const s = sentences('Hola, Sr. García. ¿Qué tal? Bien.\n\nOtro párrafo con 3.5 kilos… y fin');
  assert.deepEqual(s.map(x => x.text), ['Hola, Sr. García.', '¿Qué tal?', 'Bien.', 'Otro párrafo con 3.5 kilos…', 'y fin']);
  assert.equal(s[2].pause, 0.6, 'end of a paragraph');
  assert.equal(s[0].pause, 0.32);
  const long = Array.from({ length: 200 }, (_, i) => `palabra${i}`).join(', ');
  const cut = cutPhonemes(long);
  assert.ok(cut.length > 1 && cut.every(c => [...c].length <= MAX_PHONEMES));
  assert.equal(cut.join(' ').replace(/\s+/g, ' '), long);
  const chunks = packChunks([{ ps: 'a'.repeat(100), pause: 0.3 }, { ps: 'b'.repeat(100), pause: 0.3 }, { ps: 'c'.repeat(300), pause: 0.6 }, { ps: 'd'.repeat(10), pause: 0.3 }, { ps: long, pause: 0.3 }]);
  assert.equal(chunks[0].ps, 'a'.repeat(100) + ' ' + 'b'.repeat(100));
  assert.ok(chunks.every(c => [...c.ps].length <= MAX_PHONEMES));
  assert.equal(chunks[1].ps, 'c'.repeat(300));
  assert.equal(chunks[2].ps.startsWith('d'), true, 'a paragraph end closes the chunk');
});

test('Kokoro: ids between two zeros, the style at the phoneme count, the voices offered', () => {
  const vocab = readVocab({ model: { vocab: { $: 0, a: 43, ˈ: 156, ' ': 16 } } });
  const { ids, count } = phonemeIds(vocab, 'ˈa a?');
  assert.deepEqual([...ids], [0n, 156n, 43n, 16n, 43n, 0n]);
  assert.equal(count, 4);
  const voice = Float32Array.from({ length: 510 * 256 }, (_, i) => Math.floor(i / 256));
  assert.equal(styleFor(voice, 4)[0], 3);
  assert.equal(styleFor(voice, 9999)[0], 509);
  assert.equal(styleFor(voice, 0)[0], 0);
  assert.ok(VOICES.some(v => v.lang === 'es') && VOICES.some(v => v.lang === 'en'));
  assert.equal(voiceInfo(DEFAULT_VOICE.es).lang, 'es');
  // Every voice offered is a file of every Kokoro variant.
  const m = reg.models['text-to-speech/kokoro-82m'];
  for (const vs of Object.values(m.devices)) for (const v of vs) for (const voiceEntry of VOICES) assert.ok(v.files.includes(`main:voices/${voiceEntry.id}.bin`), voiceEntry.id);
});

test('options of the tasks: defaults, ranges, and refusals with codes', () => {
  const o = normalizeInput('text-to-music', { prompt: ' lo-fi ', seed: 7 });
  assert.deepEqual(o, { prompt: 'lo-fi', seconds: DURATION['text-to-music'].default, seed: 7, steps: 8 });
  assert.ok(Number.isInteger(normalizeInput('text-to-sfx', { prompt: 'x' }).seed));
  assert.throws(() => normalizeInput('text-to-music', { prompt: '' }), { code: 'unsupported-format' });
  assert.throws(() => normalizeInput('text-to-sfx', { prompt: 'x', seconds: 60 }), { code: 'too-large' });
  assert.throws(() => normalizeInput('text-to-music', { prompt: 'x', seed: -1 }), { code: 'unsupported-format' });
  assert.throws(() => normalizeInput('text-to-music', { prompt: 'x', steps: 2 }), { code: 'unsupported-format' });
  assert.deepEqual(normalizeSpeech({ text: 'Hi', voice: 'af_heart' }), { text: 'Hi', lang: 'en', voice: 'af_heart', speed: 1 });
  assert.deepEqual(normalizeSpeech({ text: 'Hola' }), { text: 'Hola', lang: 'es', voice: 'ef_dora', speed: 1 });
  assert.deepEqual(normalizeSpeech({ text: 'Hi', lang: 'en' }).voice, 'af_heart');
  assert.throws(() => normalizeSpeech({ text: 'x', voice: 'zz_none' }), { code: 'unsupported-format' });
  assert.throws(() => normalizeSpeech({ text: 'x', speed: 3 }), { code: 'unsupported-format' });
});

test('the public API: three task classes, their tool calls and estimates', async () => {
  for (const C of [api.Music, api.Sfx, api.Speech]) assert.equal(typeof C.estimate, 'function');
  assert.deepEqual(Object.keys(api.audio), ['music', 'sfx', 'speak']);
  const t = new api.Speech({ worker: false });
  assert.equal(t.device, null);
  await t.dispose();
  await assert.rejects(t.run({ text: 'hola' }), e => e.code === 'disposed');
  // Without WebGPU (Node), music cannot run, speech runs on WebAssembly.
  const store = { has: async () => false };
  const m = await api.Music.estimate({ registry: reg, store });
  assert.equal(m.fits, false);
  assert.equal(m.reason, 'webgpu-unavailable');
  // Spanish by default: Elffuss's own voice (MOSS-TTS-Nano); English: Kokoro.
  const es = await api.Speech.estimate({ registry: reg, store: { has: async url => url.endsWith('.json') } });
  assert.equal(es.fits, true);
  assert.equal(es.device, 'wasm');
  assert.equal(es.downloadBytes, reg.models['text-to-speech/moss-tts-nano'].devices.wasm[0].bytes);
  assert.ok(es.missingBytes < es.downloadBytes);
  const en = await api.Speech.estimate({ registry: reg, lang: 'en', store: { has: async url => url.endsWith('.bin') } });
  assert.equal(en.device, 'wasm');
  assert.ok(en.missingBytes < en.downloadBytes && en.downloadBytes === reg.models['text-to-speech/kokoro-82m'].devices.wasm[0].bytes);
  const dora = await api.Speech.estimate({ registry: reg, voice: 'ef_dora', store });
  assert.equal(dora.downloadBytes, reg.models['text-to-speech/kokoro-82m'].devices.wasm[0].bytes);
});

test('speech: the voice picks the model, Spanish without a voice is Elffuss\'s own', () => {
  const { speechModelFor, SPEECH_MODELS, VOICES, DEFAULT_VOICE } = api;
  assert.equal(speechModelFor({}), SPEECH_MODELS.moss);
  assert.equal(speechModelFor({ lang: 'es' }), SPEECH_MODELS.moss);
  assert.equal(speechModelFor({ lang: 'en' }), SPEECH_MODELS.kokoro);
  assert.equal(speechModelFor({ voice: 'es_elffuss' }, SPEECH_MODELS.kokoro), SPEECH_MODELS.moss, 'the voice wins over the model option');
  assert.equal(speechModelFor({ voice: 'ef_dora' }, SPEECH_MODELS.moss), SPEECH_MODELS.kokoro);
  assert.equal(speechModelFor({ lang: 'es' }, SPEECH_MODELS.kokoro), SPEECH_MODELS.kokoro, 'an explicit model stands when no voice says otherwise');
  assert.deepEqual(DEFAULT_VOICE, { es: 'es_elffuss', en: 'af_heart' });
  for (const v of VOICES) assert.ok(SPEECH_MODELS[v.model], v.id);
  assert.equal(new Set(VOICES.map(v => v.id)).size, VOICES.length);
  for (const id of Object.values(SPEECH_MODELS)) assert.ok(reg.models[id], id);
});

test('MOSS-TTS-Nano: the tokenizer gives the ids of SentencePiece (NFKC, dummy prefix, byte fallback)', async t => {
  assert.equal(nmtNfkc('  ﬁ  dos\tlíneas\n '), ' fi dos líneas');
  assert.equal(nmtNfkc(' \u200b '), '');
  const cache = process.env.ELFFUSS_AI_CACHE;
  const m = reg.models['text-to-speech/moss-tts-nano'].parts.tts;
  const file = cache && join(cache, 'hf', ...m.repo.split('/'), m.revision, 'tokenizer.model');
  if (!file || !existsSync(file)) { t.skip('no weight cache'); return; }
  assert.equal(await hashFile(file, m.files['tokenizer.model']), m.files['tokenizer.model'].sha256);
  const tok = createTokenizer(parseModel(readFileSync(file)), { normalize: nmtNfkc });
  const { cases } = fixture('moss-spm-ids.json');
  for (const c of cases) assert.deepEqual(tok.encode(c.text), c.ids, JSON.stringify(c.text));
});

test('MOSS-TTS-Nano: the request rows are the official runtime\'s', async () => {
  const fx = fixture('moss-frames.json');
  const voice = await import('../../sdk/audio/moss-voice-es.js');
  assert.equal(voice.CODES.length, voice.FRAMES * 16);
  assert.ok(voice.CODES.every(c => Number.isInteger(c) && c >= 0 && c < 1024));
  const { data, rows } = moss.cloneRows(MOSS_MANIFEST, voice.CODES, fx.ids);
  assert.equal(rows, fx.rows);
  assert.equal(createHash('sha256').update(Buffer.from(data.buffer)).digest('hex'), fx.rowsSha256);
  const row = moss.frameRow(MOSS_MANIFEST, fx.frames[0]);
  assert.equal(row[0], MOSS_MANIFEST.tts_config.audio_assistant_slot_token_id);
  assert.deepEqual([...row.subarray(1)], fx.frames[0]);
});

test('MOSS-TTS-Nano: the inputs of a frame draw one number for the assistant, then one per codebook', () => {
  const seen = Array.from({ length: 16 }, () => new Uint8Array(1024));
  seen[2][5] = 1;
  let n = 0;
  const { mask, assistant, audio } = moss.frameInputs(seen, () => (++n) / 100, 1024);
  assert.equal(mask.length, 16 * 1024);
  assert.equal(mask[2 * 1024 + 5], 1);
  assert.equal(mask.reduce((a, b) => a + b, 0), 1);
  assert.ok(Math.abs(assistant[0] - 0.01) < 1e-7);
  assert.ok(Math.abs(audio[0] - 0.02) < 1e-7 && Math.abs(audio[15] - 0.17) < 1e-7);
  const one = moss.frameInputs(seen, () => 1, 1024);
  assert.ok(one.assistant[0] < 1, 'a draw of 1 is kept under 1');
});

test('MOSS-TTS-Nano: text cleaning and chunks of at most 75 tokens', () => {
  assert.equal(moss.cleanText('  Hola\n\nqué tal  '), 'Hola. qué tal.');
  assert.equal(moss.cleanText('¡¡Vamos!! ¿¿Sí?? ...'), '¡Vamos! ¿Sí? …');
  assert.equal(moss.cleanText('Ya está.'), 'Ya está.');
  const count = s => s.split(/\s+/).filter(Boolean).length; // a word a token, for the test
  const one = moss.chunkText('Uno dos. Tres cuatro.', count, 75);
  assert.deepEqual(one.map(c => c.text), ['Uno dos. Tres cuatro.']);
  const long = Array.from({ length: 200 }, (_, i) => `palabra${i}`).join(' ') + '.';
  const parts = moss.chunkText(long, count, 75);
  assert.ok(parts.length >= 3 && parts.every(p => count(p.text) <= 75));
  assert.equal(parts.map(p => p.text).join(' '), long);
  const clauses = moss.chunkText(Array.from({ length: 10 }, () => 'una frase de diez palabras bastante larga para cortar aquí').join(', ') + '.', count, 30);
  assert.ok(clauses.every(p => count(p.text) <= 30) && clauses.length > 1);
  assert.ok(clauses.slice(0, -1).every(p => /,$/.test(p.text)), 'cut at commas');
});

test('MOSS-TTS-Nano: the run options', () => {
  const { normalizeMossSpeech } = mossImpl;
  const o = normalizeMossSpeech({ text: ' Hola ', seed: 3 });
  assert.deepEqual(o, { text: 'Hola', lang: 'es', voice: 'es_elffuss', seed: 3 });
  assert.ok(Number.isInteger(normalizeMossSpeech({ text: 'x' }).seed));
  assert.throws(() => normalizeMossSpeech({ text: '' }), e => e.code === 'unsupported-format');
  assert.throws(() => normalizeMossSpeech({ text: 'x', lang: 'en' }), e => e.code === 'unsupported-format');
  assert.throws(() => normalizeMossSpeech({ text: 'x', voice: 'af_heart' }), e => e.code === 'unsupported-format');
  assert.throws(() => normalizeMossSpeech({ text: 'x', seed: -1 }), e => e.code === 'unsupported-format');
  assert.throws(() => normalizeMossSpeech({ text: 'x'.repeat(20001) }), e => e.code === 'too-large');
});

test('MOSS-TTS-Nano: stereo to mono', () => {
  const data = Float32Array.from([1, 1, 0.5, 9, 0, 0, -0.5, 9]);
  assert.deepEqual([...moss.toMono(data, 2, 4, 3)], [0.5, 0.5, 0]);
});

test('decoder patch: integral double scalars become int64 in place, nothing else moves', () => {
  const tensor = v => { const b = new Uint8Array(12); b.set([0x10, 11, 0x4a, 0x08]); new DataView(b.buffer).setFloat64(4, v, true); return b; };
  const parts = [Uint8Array.from([9, 9, 9]), tensor(-1), tensor(32767), tensor(0.5), tensor(1e300), Uint8Array.from([0x10, 11, 0x4a, 0x04, 1, 2, 3, 4])];
  const bytes = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  const before = bytes.slice();
  assert.equal(doubleScalarsToInt64(bytes, { values: [-1, 1, -32767, 32767] }), 2);
  const v = new DataView(bytes.buffer);
  assert.equal(bytes[4], 7);
  assert.equal(v.getBigInt64(3 + 4, true), -1n);
  assert.equal(v.getBigInt64(15 + 4, true), 32767n);
  assert.deepEqual(bytes.subarray(27), before.subarray(27), '0.5, a huge value and other fields stay as they were');
  assert.equal(bytes.length, before.length);
});
