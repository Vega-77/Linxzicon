// ============================================================
// game.js
// Core game logic shared by solo and multiplayer.
//
// GameSession manages one round:
//   - Picks start/end words
//   - Uses LinxiconEngine (via glove.js) for word validation,
//     edge detection, and win detection
//   - Keeps a Graph (graph.js) in sync purely for rendering
//   - Saves results to Firebase via account.js
// ============================================================

import { Graph }             from "./graph.js";
import { getEngine }         from "./glove.js";
import { saveGameResult }    from "./account.js";
import { requireAuth }       from "./auth.js";
import { getConfig, onConfigChange } from "./game-config.js";
import { isValidPairWord }   from "./word-filter.js";

// ============================================================
// GameSession
// One round of gameplay. Used directly for solo mode.
// MultiplayerSession in multiplayer.js wraps this class.
// ============================================================
export class GameSession {
    // canvas   — HTMLCanvasElement (passed through to Renderer)
    // renderer — Renderer instance from render.js
    // onWin    — callback(wordsAdded: number, solveTime: number)
    // onMsg    — callback(message: string) for UI status text
    constructor(canvas, renderer, onWin, onMsg) {
        this.canvas   = canvas;
        this.renderer = renderer;
        this.onWin    = onWin;
        this.onMsg    = onMsg;

        this.graph      = null;
        this.engine     = null;
        this.boardState = null;
        this.startWord  = null;
        this.endWord    = null;
        this._startTime = null;
        this.wordsAdded = 0;
        this.finished   = false;
        this.wordsList  = []; // tracks accepted words in chronological order
    }

    // ----------------------------------------------------------
    // init
    // Sets up a fresh board with two random starting words.
    // Must be called before submitWord.
    // Returns { startWord, endWord } so the UI can display them.
    // ----------------------------------------------------------
    init() {
        const [w1, w2] = pickDistantPair();
        return this._setup(w1, w2);
    }

    // ----------------------------------------------------------
    // initWords
    // Sets up a board with specific start/end words.
    // Used by multiplayer so both players share the same pair.
    // ----------------------------------------------------------
    initWords(startWord, endWord) {
        return this._setup(startWord, endWord);
    }

    // ----------------------------------------------------------
    // _setup  (private)
    // Common initialisation for both init() and initWords().
    // ----------------------------------------------------------
    _setup(startWord, endWord) {
        this.engine     = getEngine();
        this.graph      = new Graph();
        this.finished   = false;
        this.wordsAdded = 0;
        this.wordsList  = [];
        this._startTime = Date.now();

        this.startWord  = startWord;
        this.endWord    = endWord;
        this.boardState = this.engine.createGame(startWord, endWord);

        // Seed the visual graph with the two endpoint nodes
        this.graph.addNode(startWord, []);
        this.graph.addNode(endWord,   []);

        this.renderer.graph = this.graph;
        this.renderer.setStartEnd(startWord, endWord);
        this.renderer.setWinningPath(null);
        this.renderer.start();

        this.onMsg(`Connect "${startWord}" → "${endWord}"`);
        return { startWord, endWord };
    }

    // ----------------------------------------------------------
    // submitWord
    // Validates and adds a word to the board.
    // Checks the win condition after every addition.
    //
    // Returns:
    //   { added, connections, won }  — on success
    //   { error }                    — on validation failure
    // ----------------------------------------------------------
    submitWord(rawInput) {
        if (this.finished) return { error: "Game is already over." };

        const word = rawInput.trim().toLowerCase();
        if (!word)            return { error: "Please type a word." };
        if (word.length <= 3) return { error: "Word must be more than 3 letters." };

        const { state: newState, result } = this.engine.addWord(this.boardState, word);

        if (!result.accepted) {
            if (result.reason === 'unknown_word')     return { error: `"${word}" is not in the vocabulary.` };
            if (result.reason === 'already_on_board') return { error: `"${word}" is already on the board.` };
        }

        this.boardState = newState;

        // Extract connected word names and sync to the visual graph
        const connections = result.newEdges.map(([a, b]) => a === word ? b : a);
        this.graph.addNode(word, connections);
        this.wordsAdded++;
        this.wordsList.push(word);

        if (result.won) {
            this.finished = true;
            const winPath = this.engine.shortestPath(newState);
            this.renderer.setWinningPath(winPath);
            this.onWin(this.wordsAdded, this.getElapsed());
        }

        return { added: word, connections, won: result.won };
    }

    // ----------------------------------------------------------
    // saveResult
    // Writes the game outcome to Firebase with rich analytics data.
    // opponentElo should be passed for multiplayer; null for solo.
    // ----------------------------------------------------------
    async saveResult(won, opponentElo = null, extraOverrides = {}) {
        const user = await requireAuth();
        if (!user) return;

        const engine    = this.engine;
        const newState  = this.boardState;
        const winPath   = engine ? engine.shortestPath(newState) : null;

        const extraData = {
            startWord:        this.startWord        ?? "",
            endWord:          this.endWord          ?? "",
            totalGraphWords:  this.graph ? this.graph.wordCount : this.wordsAdded,
            bestPathLength:   winPath ? winPath.length : 0,
            actualPath:       winPath ?? [],
            wordsList:        [...this.wordsList],
            ...extraOverrides,
        };

        const mode = opponentElo === null ? "solo" : "multiplayer";
        await saveGameResult(user.uid, won, this.wordsAdded, this.getElapsed(), opponentElo, mode, extraData);
    }

    // ----------------------------------------------------------
    // getElapsed
    // Seconds elapsed since _setup() was called.
    // ----------------------------------------------------------
    getElapsed() {
        if (!this._startTime) return 0;
        return Math.round((Date.now() - this._startTime) / 1000);
    }
}

// ============================================================
// Filtered word pool — proper nouns / abbreviations stripped out.
// Rebuilt when the Firebase config changes pairVocabLimit.
// ============================================================
let _filteredPool = null;

function getFilteredPool() {
    if (_filteredPool) return _filteredPool;
    const engine = getEngine();
    if (!engine) return [];
    const { pairVocabLimit } = getConfig();
    const all = engine.wordList(pairVocabLimit);
    _filteredPool = all.filter((_, i) => isValidPairWord(i));
    console.log(`[game] filtered pool: ${_filteredPool.length} valid words from top ${pairVocabLimit}`);
    return _filteredPool;
}

// Invalidate pool when config changes so it rebuilds with new limit
onConfigChange(() => { _filteredPool = null; });

function pickRandom(n) {
    const pool = getFilteredPool();
    if (!pool.length) return [];
    const out = [];
    for (let i = 0; i < n; i++) out.push(pool[Math.floor(Math.random() * pool.length)]);
    return out;
}

// ============================================================
// pickDistantPair
// Samples the filtered vocabulary (proper nouns removed) to find
// the most semantically distant non-trivial pair each game.
// pairVocabLimit and adaptiveK are live-tunable via Firebase
// (config/game) without a redeploy.
// ============================================================
function pickDistantPair() {
    const engine = getEngine();
    if (!engine) return ["ocean", "forest"];

    // Sample 30 random filtered words; find the pair with lowest similarity
    // that is non-trivial (not directly connectable) but not too disconnected.
    for (let attempt = 0; attempt < 3; attempt++) {
        const pool = pickRandom(30);
        let bestPair = null, bestSim = Infinity;

        for (let i = 0; i < pool.length; i++) {
            for (let j = i + 1; j < pool.length; j++) {
                const info = engine.pairSimilarity(pool[i], pool[j]);
                if (!info || info.isTrivial) continue;
                if (info.similarity < 0.05) continue;
                if (info.similarity < bestSim) {
                    bestSim  = info.similarity;
                    bestPair = [pool[i], pool[j]];
                }
            }
        }
        if (bestPair) return bestPair;
    }

    // Fallback: any non-trivial pair
    const pool = pickRandom(20);
    for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
            const info = engine.pairSimilarity(pool[i], pool[j]);
            if (info && !info.isTrivial) return [pool[i], pool[j]];
        }
    }
    return pickRandom(2);
}

// ============================================================
// pickStartEnd  (exported)
// Used by multiplayer.js so the host can generate a shared
// start/end pair and write it to Firebase for both players.
// ============================================================
export function pickStartEnd() {
    return pickDistantPair();
}
