# test

```bash
node test/engine.test.js
# or from the game/ root:
npm test
```

Tests cover the game engine logic and the embeddings loader. No test framework needed, just Node.js.

The engine tests use a small in-memory word set so they run instantly. The loader tests use `data/sample.bin` — if that file is missing it gets generated automatically.
