const IS_NODE = typeof globalThis.window === 'undefined';

// Bump this string whenever embeddings.bin is rebuilt so the old cache is ignored.
const EMBEDDINGS_CACHE = 'linxicon-embeddings-v3';

// onProgress: ({ loaded: number, total: number }) => void  — optional
async function readBuffer(source, onProgress) {
  if (IS_NODE) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(source);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  // Try the Cache API first (persists across sessions)
  if ('caches' in globalThis) {
    try {
      const cache = await caches.open(EMBEDDINGS_CACHE);
      const cached = await cache.match(source);
      if (cached) {
        const ab = await cached.arrayBuffer();
        onProgress?.({ loaded: ab.byteLength, total: ab.byteLength });
        return ab;
      }
    } catch (_) {}
  }

  // Download from network with streaming progress
  const res = await fetch(source);
  if (!res.ok) throw new Error(`Failed to fetch ${source}: ${res.status}`);

  const total = parseInt(res.headers.get('Content-Length') || '0', 10);
  let loaded = 0;
  const chunks = [];

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total: total || loaded });
  }

  // Reassemble into a single ArrayBuffer
  const combined = new Uint8Array(loaded);
  let pos = 0;
  for (const chunk of chunks) { combined.set(chunk, pos); pos += chunk.byteLength; }
  const buffer = combined.buffer;

  // Store in cache (reconstruct Response so we don't need to clone a consumed body)
  if ('caches' in globalThis) {
    try {
      const cache = await caches.open(EMBEDDINGS_CACHE);
      cache.put(source, new Response(buffer.slice(0), { headers: res.headers })).catch(() => {});
    } catch (_) {}
  }

  return buffer;
}

/**
 * Loads a LINX binary embeddings file.
 * Returns Map<string, { vec: Float32Array, mean: number, std: number }>
 *
 * source:      file path (Node.js) or URL (browser)
 * onProgress:  optional ({ loaded, total }) callback for download progress
 */
export async function loadEmbeddings(source, onProgress) {
  const buffer = await readBuffer(source, onProgress);
  const view = new DataView(buffer);

  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1),
    view.getUint8(2), view.getUint8(3)
  );
  if (magic !== 'LINX') throw new Error('Invalid embeddings file: bad magic bytes');

  const version = view.getUint32(4, true);
  if (version !== 1) throw new Error(`Unsupported embeddings version: ${version}`);

  const vocabSize = view.getUint32(8, true);
  const dims = view.getUint32(12, true);

  let offset = 16;

  // Word lengths (Uint16, one per word)
  const wordLengths = new Uint16Array(buffer.slice(offset, offset + vocabSize * 2));
  offset += vocabSize * 2;

  // Word strings (concatenated UTF-8)
  const decoder = new TextDecoder();
  const words = new Array(vocabSize);
  for (let i = 0; i < vocabSize; i++) {
    const len = wordLengths[i];
    words[i] = decoder.decode(new Uint8Array(buffer, offset, len));
    offset += len;
  }

  // Pad to 4-byte alignment for Float32 data
  if (offset % 4 !== 0) offset += 4 - (offset % 4);

  const embByteLen = vocabSize * dims * 4;
  const embeddings = new Float32Array(buffer.slice(offset, offset + embByteLen));
  offset += embByteLen;

  const means = new Float32Array(buffer.slice(offset, offset + vocabSize * 4));
  offset += vocabSize * 4;

  const stds = new Float32Array(buffer.slice(offset, offset + vocabSize * 4));

  const map = new Map();
  for (let i = 0; i < vocabSize; i++) {
    map.set(words[i], {
      vec: embeddings.subarray(i * dims, (i + 1) * dims),
      mean: means[i],
      std: stds[i],
    });
  }

  return map;
}
