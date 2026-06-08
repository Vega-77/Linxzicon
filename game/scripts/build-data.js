/**
 * build-data.js — converts a raw GloVe text file into the LINX binary format.
 *
 * Usage:
 *   node scripts/build-data.js <glove-file> [options]
 *
 * Options:
 *   --wordlist  <file>    Word frequency filter list (default: scripts/data/wordlist.txt)
 *   --out       <file>    Output path (default: data/embeddings.bin)
 *   --sample    <n>       Use n random samples for mean/std estimation instead of exact O(n²)
 *                         Exact is more accurate; sampling is ~20x faster (n=1000 ≈ 3s for 20k words)
 *
 * Output format: LINX binary v1 (see src/loader.js for spec)
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.log('Usage: node scripts/build-data.js <glove-file> [--wordlist <file>] [--top <n>] [--out <file>] [--sample <n>]');
  console.log('  --top <n>      Take the top N alphabetic words by GloVe frequency (no wordlist needed)');
  process.exit(0);
}

function argVal(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const gloveFile    = resolve(args[0]);
const topN         = argVal('--top')    ? parseInt(argVal('--top'),    10) : null;
const wordlistFile = argVal('--wordlist') ?? (topN ? null : resolve(__dirname, 'data/wordlist.txt'));
const outFile      = argVal('--out')    ?? resolve(__dirname, '../data/embeddings.bin');
const sampleSize   = argVal('--sample') ? parseInt(argVal('--sample'), 10) : null;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let allowedWords = null;
if (wordlistFile) {
  console.log('Loading word list...');
  const wordlistText = await readFile(wordlistFile, 'utf8');
  allowedWords = new Set(
    wordlistText.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean)
  );
  console.log(`  ${allowedWords.size} words in filter list`);
} else {
  console.log(`Using top-${topN} mode (alphabetic words ≥ 4 chars, sorted by GloVe frequency)`);
}

console.log('Parsing GloVe...');
const words  = [];
const allVecs = [];
let dims = -1;
let linesRead = 0;

const rl = createInterface({ input: createReadStream(gloveFile), crlfDelay: Infinity });

for await (const line of rl) {
  linesRead++;
  if (linesRead % 50000 === 0) process.stdout.write(`  ${linesRead} lines\r`);

  const firstSpace = line.indexOf(' ');
  if (firstSpace === -1) continue;

  const word = line.slice(0, firstSpace).toLowerCase();
  if (word.length <= 3) continue;
  if (!/^[a-z]+$/.test(word)) continue;
  if (allowedWords && !allowedWords.has(word)) continue;
  if (topN !== null && words.length >= topN) break;

  const parts = line.slice(firstSpace + 1).split(' ');
  if (dims === -1) dims = parts.length;
  if (parts.length !== dims) continue;

  const vec = new Float32Array(dims);
  for (let i = 0; i < dims; i++) vec[i] = parseFloat(parts[i]);

  // Normalize to unit length
  let mag = 0;
  for (const v of vec) mag += v * v;
  mag = Math.sqrt(mag);
  if (mag === 0) continue;
  for (let i = 0; i < dims; i++) vec[i] /= mag;

  words.push(word);
  allVecs.push(vec);
}

console.log(`\nLoaded ${words.length} words (${dims} dims)`);

const vocabSize = words.length;
if (vocabSize === 0) {
  console.error('No words loaded. Check the GloVe file path and word list.');
  process.exit(1);
}

// Pack all vectors into a single flat Float32Array for cache-efficient access
const flatVecs = new Float32Array(vocabSize * dims);
for (let i = 0; i < vocabSize; i++) {
  flatVecs.set(allVecs[i], i * dims);
}

// ---------------------------------------------------------------------------
// Compute per-word mean and std of cosine similarities
// ---------------------------------------------------------------------------

console.log(sampleSize
  ? `Computing per-word stats (sampling ${sampleSize} pairs per word)...`
  : `Computing per-word stats (exact O(n²), n=${vocabSize})...`
);

const means = new Float32Array(vocabSize);
const stds  = new Float32Array(vocabSize);

const t0 = Date.now();

for (let i = 0; i < vocabSize; i++) {
  if (i % 500 === 0) {
    const elapsed = (Date.now() - t0) / 1000;
    const pct = (i / vocabSize * 100).toFixed(1);
    process.stdout.write(`  ${pct}%  (${elapsed.toFixed(0)}s elapsed)\r`);
  }

  const iStart = i * dims;
  let m = 0, m2 = 0, count = 0;

  if (sampleSize) {
    // Random sample
    for (let s = 0; s < sampleSize; s++) {
      const j = Math.floor(Math.random() * (vocabSize - 1));
      const jj = j >= i ? j + 1 : j;  // skip self
      const dot = _dot(flatVecs, iStart, jj * dims, dims);
      count++;
      const delta = dot - m;
      m += delta / count;
      m2 += delta * (dot - m);
    }
  } else {
    // Exact
    for (let j = 0; j < vocabSize; j++) {
      if (j === i) continue;
      const dot = _dot(flatVecs, iStart, j * dims, dims);
      count++;
      const delta = dot - m;
      m += delta / count;
      m2 += delta * (dot - m);
    }
  }

  means[i] = m;
  stds[i]  = count > 1 ? Math.sqrt(m2 / (count - 1)) : 0;
}

console.log(`\nStats done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Write binary file
// ---------------------------------------------------------------------------

console.log(`Writing ${outFile}...`);

const encoder = new TextEncoder();
const wordBytes = words.map(w => encoder.encode(w));
const totalWordBytes = wordBytes.reduce((s, b) => s + b.length, 0);

// Compute padding needed to align embeddings to 4 bytes
const afterWords = 16 + vocabSize * 2 + totalWordBytes;
const pad = (4 - (afterWords % 4)) % 4;
const totalSize = afterWords + pad + vocabSize * dims * 4 + vocabSize * 4 * 2;

const outBuf = new ArrayBuffer(totalSize);
const outView = new DataView(outBuf);
const outU8   = new Uint8Array(outBuf);

// Header
outU8[0] = 0x4C; outU8[1] = 0x49; outU8[2] = 0x4E; outU8[3] = 0x58; // "LINX"
outView.setUint32(4,  1,         true); // version
outView.setUint32(8,  vocabSize, true);
outView.setUint32(12, dims,      true);

let offset = 16;

// Word lengths
for (let i = 0; i < vocabSize; i++) {
  outView.setUint16(offset, wordBytes[i].length, true);
  offset += 2;
}

// Word strings
for (let i = 0; i < vocabSize; i++) {
  outU8.set(wordBytes[i], offset);
  offset += wordBytes[i].length;
}

// Alignment padding
offset += pad;

// Embeddings
const embF32 = new Float32Array(outBuf, offset, vocabSize * dims);
embF32.set(flatVecs);
offset += vocabSize * dims * 4;

// Means
const meansF32 = new Float32Array(outBuf, offset, vocabSize);
meansF32.set(means);
offset += vocabSize * 4;

// Stds
const stdsF32 = new Float32Array(outBuf, offset, vocabSize);
stdsF32.set(stds);

await writeFile(outFile, Buffer.from(outBuf));

const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
console.log(`Done. Wrote ${vocabSize} words, ${sizeMB} MB → ${outFile}`);

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function _dot(flat, iStart, jStart, dims) {
  let sum = 0;
  for (let k = 0; k < dims; k++) sum += flat[iStart + k] * flat[jStart + k];
  return sum;
}
