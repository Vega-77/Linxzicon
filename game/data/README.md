# data

- `embeddings.bin` — the main data file (~8MB). Contains pre-normalized word vectors for ~20,000 common English words at 100 dimensions, plus per-word similarity stats used by the adaptive threshold system.
- `sample.bin` — a small synthetic version (~200 words) used by the tests.

Both files are committed so everything works out of the box.
