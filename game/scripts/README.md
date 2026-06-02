# scripts

Build scripts, not part of the game itself.

- `build-data.js` — takes a GloVe text file and produces `data/embeddings.bin`. Only need to run this if you're rebuilding the embeddings from scratch.
- `create-sample.js` — generates `data/sample.bin`, a small synthetic word set used by the tests. Run this if `sample.bin` is missing.

```bash
node scripts/build-data.js <glove-file>
node scripts/create-sample.js
```
