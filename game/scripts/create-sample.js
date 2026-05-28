/**
 * create-sample.js — generates game/data/sample.bin with synthetic test data.
 *
 * The sample uses hand-crafted word clusters so the engine tests have
 * predictable similarity structure (words in the same cluster connect;
 * words in different clusters do not).
 *
 * Usage: node scripts/create-sample.js [--out data/sample.bin]
 */

import { writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outFile = resolve(__dirname, '..', argVal('--out') ?? 'data/sample.bin');

function argVal(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const DIMS = 100;

// Each cluster: words that should be mutually similar.
// They'll share a strong component in a dedicated dimension band.
const CLUSTERS = [
  ['music',    'song',    'melody',   'rhythm',   'beat',    'tune',    'chord',   'lyrics',   'album',    'concert'],
  ['science',  'physics', 'chemistry','biology',  'research','theory',  'experiment','data',   'analysis', 'study'],
  ['food',     'meal',    'dinner',   'lunch',    'breakfast','recipe', 'cooking',  'taste',   'flavor',   'kitchen'],
  ['sport',    'team',    'player',   'score',    'match',   'compete', 'field',    'race',    'champion', 'athlete'],
  ['travel',   'journey', 'voyage',   'adventure','explore', 'route',   'destination','trip',  'tour',     'passport'],
  ['ocean',    'river',   'lake',     'water',    'wave',    'stream',  'flood',    'coast',   'shore',    'tide'],
  ['light',    'bright',  'shine',    'glow',     'flash',   'beam',    'radiant',  'sunny',   'glare',    'illuminate'],
  ['dark',     'night',   'shadow',   'black',    'shade',   'dusk',    'gloom',    'murky',   'obscure',  'twilight'],
  ['forest',   'tree',    'branch',   'leaf',     'plant',   'nature',  'garden',   'grass',   'woodland', 'jungle'],
  ['city',     'town',    'urban',    'street',   'building','house',   'office',   'district','suburb',   'village'],
  ['happy',    'joyful',  'smile',    'laugh',    'cheer',   'delight', 'pleasure', 'bliss',   'elated',   'content'],
  ['angry',    'furious', 'rage',     'upset',    'hostile', 'bitter',  'fierce',   'wrathful','irritated','outraged'],
  ['mind',     'thought', 'idea',     'dream',    'imagine', 'brain',   'memory',   'logic',   'reason',   'intellect'],
  ['heart',    'love',    'emotion',  'feeling',  'passion', 'soul',    'spirit',   'devotion','affection','warmth'],
  ['fire',     'flame',   'burn',     'heat',     'smoke',   'ember',   'torch',    'blaze',   'ignite',   'inferno'],
  ['cold',     'snow',    'freeze',   'winter',   'frost',   'chill',   'polar',    'arctic',  'icy',      'blizzard'],
  ['fast',     'quick',   'speed',    'rapid',    'swift',   'sprint',  'rush',     'dash',    'hurry',    'velocity'],
  ['slow',     'calm',    'quiet',    'peaceful', 'gentle',  'mild',    'soft',     'tender',  'serene',   'tranquil'],
  ['large',    'huge',    'massive',  'enormous', 'vast',    'giant',   'immense',  'grand',   'colossal', 'towering'],
  ['small',    'tiny',    'little',   'mini',     'slight',  'narrow',  'thin',     'minor',   'petite',   'compact'],
];

// ---------------------------------------------------------------------------
// Generate synthetic embeddings
// ---------------------------------------------------------------------------

const rng = mulberry32(0xDEADBEEF);

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function normalize(vec) {
  let mag = 0;
  for (const v of vec) mag += v * v;
  mag = Math.sqrt(mag);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / mag;
  return out;
}

function dot(v1, v2) {
  let sum = 0;
  for (let i = 0; i < v1.length; i++) sum += v1[i] * v2[i];
  return sum;
}

const words = [];
const vecs  = [];

for (let c = 0; c < CLUSTERS.length; c++) {
  // Each cluster gets 5 "signal" dimensions (strong component) and noise elsewhere.
  // 20 clusters × 5 dims = 100 dims exactly.
  const dStart = c * 5;

  for (const word of CLUSTERS[c]) {
    const raw = new Float32Array(DIMS);

    // Signal: strong in this cluster's band
    for (let d = dStart; d < dStart + 5; d++) {
      raw[d] = 2.0 + (rng() - 0.5) * 0.4;
    }

    // Noise: small random values everywhere else
    for (let d = 0; d < DIMS; d++) {
      if (d < dStart || d >= dStart + 5) {
        raw[d] = (rng() - 0.5) * 0.15;
      }
    }

    words.push(word);
    vecs.push(normalize(Array.from(raw)));
  }
}

const vocabSize = words.length;
console.log(`Generated ${vocabSize} words across ${CLUSTERS.length} clusters`);

// ---------------------------------------------------------------------------
// Compute exact per-word mean/std (small vocab — trivially fast)
// ---------------------------------------------------------------------------

const means = new Float32Array(vocabSize);
const stds  = new Float32Array(vocabSize);

for (let i = 0; i < vocabSize; i++) {
  const sims = [];
  for (let j = 0; j < vocabSize; j++) {
    if (i !== j) sims.push(dot(vecs[i], vecs[j]));
  }
  const mean = sims.reduce((a, b) => a + b) / sims.length;
  const variance = sims.reduce((a, b) => a + (b - mean) ** 2, 0) / (sims.length - 1);
  means[i] = mean;
  stds[i]  = Math.sqrt(variance);
}

// Quick sanity check: words in same cluster should connect at adaptiveK=1.0
const k = 1.0;
const e0 = { vec: vecs[0], mean: means[0], std: stds[0] };
const e1 = { vec: vecs[1], mean: means[1], std: stds[1] };
const e10 = { vec: vecs[10], mean: means[10], std: stds[10] };
const sameSim  = dot(vecs[0], vecs[1]);
const crossSim = dot(vecs[0], vecs[10]);
const sameThresh  = Math.max(means[0], means[1])  + k * Math.max(stds[0], stds[1]);
const crossThresh = Math.max(means[0], means[10]) + k * Math.max(stds[0], stds[10]);
console.log(`Sanity (same cluster):  sim=${sameSim.toFixed(3)} threshold=${sameThresh.toFixed(3)} → ${sameSim >= sameThresh ? 'CONNECTS ✓' : 'NO EDGE'}`);
console.log(`Sanity (diff cluster):  sim=${crossSim.toFixed(3)} threshold=${crossThresh.toFixed(3)} → ${crossSim >= crossThresh ? 'CONNECTS' : 'NO EDGE ✓'}`);

// ---------------------------------------------------------------------------
// Write binary
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const wordBytes = words.map(w => encoder.encode(w));
const totalWordBytes = wordBytes.reduce((s, b) => s + b.length, 0);

const afterWords = 16 + vocabSize * 2 + totalWordBytes;
const pad = (4 - (afterWords % 4)) % 4;
const totalSize = afterWords + pad + vocabSize * DIMS * 4 + vocabSize * 4 * 2;

const buf  = new ArrayBuffer(totalSize);
const view = new DataView(buf);
const u8   = new Uint8Array(buf);

// Header: "LINX"
u8[0] = 0x4C; u8[1] = 0x49; u8[2] = 0x4E; u8[3] = 0x58;
view.setUint32(4,  1,         true);
view.setUint32(8,  vocabSize, true);
view.setUint32(12, DIMS,      true);

let offset = 16;
for (const wb of wordBytes) { view.setUint16(offset, wb.length, true); offset += 2; }
for (const wb of wordBytes) { u8.set(wb, offset); offset += wb.length; }
offset += pad;

const embF32   = new Float32Array(buf, offset, vocabSize * DIMS);
for (let i = 0; i < vocabSize; i++) embF32.set(vecs[i], i * DIMS);
offset += vocabSize * DIMS * 4;

const meansF32 = new Float32Array(buf, offset, vocabSize);
meansF32.set(means);
offset += vocabSize * 4;

const stdsF32  = new Float32Array(buf, offset, vocabSize);
stdsF32.set(stds);

await writeFile(outFile, Buffer.from(buf));
console.log(`Wrote ${outFile} (${(totalSize / 1024).toFixed(1)} KB)`);
