# Linxicon

A word game where you try to connect two words by adding words in between. Words connect when they're similar enough in meaning — like how "music" and "sound" are close, but "music" and "table" aren't.

## How it works

You're given a start word and a target word. Each turn you add a word to the board. If your word is similar enough to words already on the board, edges form between them. You win when there's a path connecting the start word to the target word through the graph.

## Repo structure

```
game/           JavaScript game engine (works in Node.js and the browser)
preprocessing/  Java tools for processing the GloVe word embeddings dataset
```

## Setup

### Game engine
```bash
cd game
npm test
```

### Building the full embeddings file
The pre-built `game/data/embeddings.bin` (~8MB, ~20k words) is already committed so you don't need to do this. But if you want to rebuild it from scratch, download the GloVe dataset (see `preprocessing/README.md`) then:
```bash
cd game
node scripts/build-data.js ../preprocessing/data.txt
```
