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
// WORD_BANK
// Curated words guaranteed to exist in the GloVe vocabulary.
// Pairs are chosen at random; trivial pairs (words already
// similar enough to connect directly) are skipped.
// ============================================================
const WORD_BANK = [
    "ocean", "forest", "music", "castle", "diamond",
    "dragon", "thunder", "garden", "mirror", "shadow",
    "silver", "golden", "winter", "summer", "river",
    "mountain", "desert", "island", "flame", "storm",
    "crystal", "cloud", "ancient", "sword", "kingdom",
    "tiger", "eagle", "wolf", "whale", "falcon",
    "piano", "violin", "guitar", "canvas", "marble",
    "captain", "voyage", "jungle", "prairie", "glacier"
];

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
    }

    // ----------------------------------------------------------
    // init
    // Sets up a fresh board with two random starting words.
    // Must be called before submitWord.
    // Returns { startWord, endWord } so the UI can display them.
    // ----------------------------------------------------------
    init() {
        const [w1, w2] = pickStartPair();
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
            if (result.reason === 'unknown_word')    return { error: `"${word}" is not in the vocabulary.` };
            if (result.reason === 'already_on_board') return { error: `"${word}" is already on the board.` };
        }

        this.boardState = newState;

        // Extract connected word names and sync to the visual graph
        const connections = result.newEdges.map(([a, b]) => a === word ? b : a);
        this.graph.addNode(word, connections);
        this.wordsAdded++;

        if (result.won) {
            this.finished = true;
            this.renderer.setWinningPath(this.engine.shortestPath(newState));
            this.onWin(this.wordsAdded, this.getElapsed());
        }

        return { added: word, connections, won: result.won };
    }

    // ----------------------------------------------------------
    // saveResult
    // Writes the game outcome to Firebase.
    // opponentElo should be passed for multiplayer; null for solo.
    // ----------------------------------------------------------
    async saveResult(won, opponentElo = null) {
        const user = await requireAuth();
        if (!user) return;
        await saveGameResult(user.uid, won, this.wordsAdded, this.getElapsed(), opponentElo);
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
// pickStartPair
// Returns two distinct words from WORD_BANK that are not
// already too similar (avoids trivially easy starting pairs).
// ============================================================
function pickStartPair() {
    const engine = getEngine();
    for (let attempt = 0; attempt < 20; attempt++) {
        const [w1, w2] = pickTwoDistinct(WORD_BANK);
        if (!engine) return [w1, w2];
        const info = engine.pairSimilarity(w1, w2);
        if (info && !info.isTrivial) return [w1, w2];
    }
    return pickTwoDistinct(WORD_BANK);
}

function pickTwoDistinct(arr) {
    const i = Math.floor(Math.random() * arr.length);
    let   j = Math.floor(Math.random() * (arr.length - 1));
    if (j >= i) j++;
    return [arr[i], arr[j]];
}

// ============================================================
// pickStartEnd  (exported)
// Used by multiplayer.js so the host can generate a shared
// start/end pair and write it to Firebase for both players.
// ============================================================
export function pickStartEnd() {
    return pickStartPair();
}
