// ============================================================
// glove.js — debug version
// Wraps loader + engine. Heavy console logging so we can see
// exactly where the embeddings load fails.
// ============================================================

import { loadEmbeddings } from '../game/src/loader.js';
import { LinxiconEngine } from '../game/src/engine.js';

let _engine = null;

export async function loadGlove(filepath = 'game/data/embeddings.bin', onProgress) {
    if (_engine) {
        return;
    }

    try {
        // Test that the file is reachable before handing off to loader
        const probe = await fetch(filepath, { method: "HEAD" });
        if (!probe.ok) {
            throw new Error(`File not reachable: HTTP ${probe.status} — is embeddings.bin in the right folder?`);
        }
    } catch (err) {
        console.error("[glove] HEAD probe failed:", err);
        throw err;
    }

    try {
        const emb = await loadEmbeddings(filepath, onProgress);

        if (!emb || emb.size === 0) {
            throw new Error("Embeddings map is empty — the .bin file may be corrupt or wrong format");
        }

        _engine = new LinxiconEngine(emb, { adaptiveK: 2.5 });
        console.log("[glove] engine ready, vocab size:", emb.size);

    } catch (err) {
        console.error("[glove] loadEmbeddings failed:", err);
        throw err;
    }
}

export function isEmbeddingsLoaded() {
    return _engine !== null;
}

export function getEngine() {
    if (!_engine) console.warn("[glove] getEngine() called before loadGlove() completed");
    return _engine;
}

export function isInVocabulary(word) {
    return _engine?.hasWord(word) ?? false;
}

export function getConnections(newWord, boardWords) {
    if (!_engine) {
        console.warn("[glove] getConnections called but engine not ready");
        return [];
    }
    const connections = [];
    for (const boardWord of boardWords) {
        const info = _engine.pairSimilarity(newWord, boardWord);
        if (info?.isTrivial) connections.push(boardWord);
    }
    return connections;
}