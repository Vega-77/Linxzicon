// ============================================================
// glove.js — debug version
// Wraps loader + engine. Heavy console logging so we can see
// exactly where the embeddings load fails.
// ============================================================

import { loadEmbeddings } from '../game/src/loader.js';
import { LinxiconEngine } from '../game/src/engine.js';

let _engine = null;

export async function loadGlove(filepath = 'game/data/embeddings.bin') {
    if (_engine) {
        console.log("[glove] already loaded, skipping");
        return;
    }

    console.log("[glove] starting load from:", filepath);

    try {
        // Test that the file is reachable before handing off to loader
        const probe = await fetch(filepath, { method: "HEAD" });
        console.log("[glove] HEAD probe:", probe.status, probe.statusText,
            "Content-Length:", probe.headers.get("content-length"));
        if (!probe.ok) {
            throw new Error(`File not reachable: HTTP ${probe.status} — is embeddings.bin in the right folder?`);
        }
    } catch (err) {
        console.error("[glove] HEAD probe failed:", err);
        throw err;
    }

    try {
        console.log("[glove] calling loadEmbeddings...");
        const emb = await loadEmbeddings(filepath);
        console.log("[glove] loadEmbeddings returned, type:", typeof emb,
            "is Map:", emb instanceof Map,
            "size:", emb?.size);

        if (!emb || emb.size === 0) {
            throw new Error("Embeddings map is empty — the .bin file may be corrupt or wrong format");
        }

        // Spot-check a few entries
        let count = 0;
        for (const [word, entry] of emb) {
            console.log(`[glove] sample entry: "${word}" → vec length ${entry.vec?.length}, mean ${entry.mean?.toFixed(4)}, std ${entry.std?.toFixed(4)}`);
            if (++count >= 3) break;
        }

        _engine = new LinxiconEngine(emb, { adaptiveK: 2.0 });
        console.log("[glove] engine ready, vocab size:", emb.size);

    } catch (err) {
        console.error("[glove] loadEmbeddings failed:", err);
        throw err;
    }
}

export function getEngine() {
    if (!_engine) console.warn("[glove] getEngine() called before loadGlove() completed");
    return _engine;
}

export function isInVocabulary(word) {
    const result = _engine?.hasWord(word) ?? false;
    if (!result) console.log(`[glove] isInVocabulary("${word}") = false`);
    return result;
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
    console.log(`[glove] getConnections("${newWord}", [${[...boardWords].join(",")}]) → [${connections.join(",")}]`);
    return connections;
}