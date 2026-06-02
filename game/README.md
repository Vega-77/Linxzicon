# linxicon-engine

The core game logic for Linxicon. Works in both Node.js and the browser, no dependencies.

## Install / run tests

```bash
npm test
```

The tests use a small built-in word set so they work right away without needing the full embeddings file.

## Data files

`data/embeddings.bin` (~8MB, ~20k words at 100 dimensions) is committed so you can use it right away.

`data/sample.bin` is a smaller synthetic file used by the tests.

If you ever need to rebuild `embeddings.bin` from scratch (you probably don't):
```bash
# download GloVe first — see ../preprocessing/README.md
node scripts/build-data.js ../preprocessing/data.txt
```

## Usage

```js
import { LinxiconEngine, loadEmbeddings } from './src/index.js';

const emb = await loadEmbeddings('./data/embeddings.bin');
const engine = new LinxiconEngine(emb);

let state = engine.createGame('music', 'science');

let { state: s2, result } = engine.addWord(state, 'sound');
console.log(result.newEdges);   // edges formed by this word
console.log(result.won);        // true if a path now exists

console.log(engine.shortestPath(s2)); // ['music', 'sound', ...]
```

## How similarity works

Each word has a pre-computed mean and standard deviation of its cosine similarity to all other words. When adding a word to the board, it connects to an existing word only if their similarity exceeds:

```
threshold = max(meanA, meanB) + adaptiveK × max(stdA, stdB)
```

This stops common/generic words (like "thing" or "good") from bridging everything trivially — they have a higher threshold because they're already close to everything.

You can tune `adaptiveK` (default `1.0`). Lower = easier connections, higher = harder.

```js
const engine = new LinxiconEngine(emb, { adaptiveK: 0.5 });
```

## File structure

```
src/
  engine.js     game logic (pure, no I/O)
  loader.js     loads embeddings.bin (Node.js or browser)
  index.js      main export
scripts/
  build-data.js    GloVe text → embeddings.bin
  create-sample.js generates the sample.bin test file
data/
  sample.bin    small word set for testing (committed)
  embeddings.bin  full word set (not committed, ~8MB)
test/
  engine.test.js
```
