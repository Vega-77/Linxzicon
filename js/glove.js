// Loads word embeddings and exposes vocabulary + connection helpers.
// The rest of the app imports from here; only this file knows about
// the binary format or LinxiconEngine.

import { loadEmbeddings } from '../game/src/loader.js';
import { LinxiconEngine } from '../game/src/engine.js';

let _engine = null;

// ── loadGlove ──────────────────────────────────────────────────
// Loads embeddings.bin and initialises the engine.
// Must be awaited once before any other export is used.
export async function loadGlove(filepath = 'game/data/embeddings.bin') {
    if (_engine) return;
    const emb = await loadEmbeddings(filepath);
    _engine = new LinxiconEngine(emb);
    console.log(`Embeddings loaded: ${emb.size} words`);
}

// ── getEngine ──────────────────────────────────────────────────
// Returns the shared LinxiconEngine instance.
// game.js uses this to drive game state.
export function getEngine() {
    return _engine;
}

// ── isInVocabulary ─────────────────────────────────────────────
export function isInVocabulary(word) {
    return _engine?.hasWord(word) ?? false;
}

// ── getConnections ─────────────────────────────────────────────
// Returns board words that the new word should connect to,
// using the same adaptive threshold as the engine.
export function getConnections(newWord, boardWords) {
    if (!_engine) return [];
    const connections = [];
    for (const boardWord of boardWords) {
        const info = _engine.pairSimilarity(newWord, boardWord);
        if (info?.isTrivial) connections.push(boardWord);
    }
    return connections;
}
