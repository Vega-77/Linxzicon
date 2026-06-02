# src

The actual game engine code.

- `engine.js` — all the game logic (adding words, checking for a win, BFS path finding). No I/O, no dependencies, works anywhere.
- `loader.js` — reads an `embeddings.bin` file. Works in both Node.js (uses `fs`) and the browser (uses `fetch`).
- `index.js` — exports everything, use this as the entry point.
- `index.cjs` — same thing but for CommonJS (`require()`).
