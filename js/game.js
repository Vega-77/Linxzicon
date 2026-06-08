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

import { Graph }          from "./graph.js";
import { getEngine }      from "./glove.js";
import { saveGameResult } from "./account.js";
import { requireAuth }    from "./auth.js";

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
// pickDistantPair
// Samples the full 200k vocabulary to find the most semantically
// distant non-trivial pair each game — words far apart enough
// to be challenging but still positively related (similarity ≥ 0.05)
// so a connecting path exists through the word network.
// Only the top PAIR_VOCAB_LIMIT words (by GloVe frequency) are eligible
// as start/end words. Connecting words typed by the player are unlimited.
const PAIR_VOCAB_LIMIT = 25000;

// ============================================================
function pickDistantPair() {
    const engine = getEngine();
    if (!engine) return ["ocean", "forest"];

    // Sample 30 random words; find the pair with lowest similarity
    // that is non-trivial (not already directly connectable).
    // Retry up to 3 times in case the sample is unlucky.
    for (let attempt = 0; attempt < 3; attempt++) {
        const pool = engine.randomWords(30, PAIR_VOCAB_LIMIT);
        let bestPair = null, bestSim = Infinity;

        for (let i = 0; i < pool.length; i++) {
            for (let j = i + 1; j < pool.length; j++) {
                const info = engine.pairSimilarity(pool[i], pool[j]);
                if (!info || info.isTrivial) continue;
                if (info.similarity < 0.05) continue; // too disconnected
                if (info.similarity < bestSim) {
                    bestSim  = info.similarity;
                    bestPair = [pool[i], pool[j]];
                }
            }
        }
        if (bestPair) return bestPair;
    }

    // Fallback: any non-trivial pair
    const pool = engine.randomWords(20, PAIR_VOCAB_LIMIT);
    for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
            const info = engine.pairSimilarity(pool[i], pool[j]);
            if (info && !info.isTrivial) return [pool[i], pool[j]];
        }
    }
    return engine.randomWords(2, PAIR_VOCAB_LIMIT);
}

// ============================================================
// pickStartEnd  (exported)
// Used by multiplayer.js so the host can generate a shared
// start/end pair and write it to Firebase for both players.
// ============================================================
export function pickStartEnd() {
    return pickDistantPair();
}
