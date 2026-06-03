// ============================================================
// game.js
// Core game logic shared by solo and multiplayer.
//
// GameSession manages one round:
//   - Picks start/end words
//   - Handles word submission + edge creation
//   - Checks the win condition via BFS
//   - Saves results to Firebase via account.js
// ============================================================

import { Graph }                         from "./graph.js";
import { getConnections, isInVocabulary } from "./glove.js";
import { saveGameResult }                 from "./account.js";
import { requireAuth }                    from "./auth.js";

// ============================================================
// WORD_BANK
// Curated words guaranteed to exist in the GloVe vocabulary.
// Two are chosen at random as the start and end words for
// each game. Expand this list to increase variety.
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
        this.startWord  = null;
        this.endWord    = null;
        this._startTime = null;
        this.wordsAdded = 0;    // words typed by the player (excludes the 2 starting words)
        this.finished   = false;
    }

    // ----------------------------------------------------------
    // init
    // Sets up a fresh board with two random starting words.
    // Must be called before submitWord.
    // Returns { startWord, endWord } so the UI can display them.
    // ----------------------------------------------------------
    init() {
        this.graph      = new Graph();
        this.finished   = false;
        this.wordsAdded = 0;
        this._startTime = Date.now();

        const [w1, w2]  = pickTwoRandom(WORD_BANK);
        this.startWord  = w1;
        this.endWord    = w2;

        // Place both starting words on the board with no edges yet
        this.graph.addNode(w1, []);
        this.graph.addNode(w2, []);

        // Point the renderer at this session's graph
        this.renderer.graph = this.graph;
        this.renderer.setStartEnd(w1, w2);
        this.renderer.setWinningPath(null);
        this.renderer.start();

        this.onMsg(`Connect "${w1}" → "${w2}"`);
        return { startWord: w1, endWord: w2 };
    }

    // ----------------------------------------------------------
    // submitWord
    // Validates and adds a word to the board.
    // Checks the win condition after every addition.
    //
    // Returns an object:
    //   { added, connections, won }  — on success
    //   { error }                    — on validation failure
    // ----------------------------------------------------------
    submitWord(rawInput) {
        if (this.finished) return { error: "Game is already over." };

        const word = rawInput.trim().toLowerCase();

        if (!word)            return { error: "Please type a word." };
        if (word.length <= 3) return { error: "Word must be more than 3 letters." };

        if (!isInVocabulary(word)) {
            return { error: `"${word}" is not in the vocabulary.` };
        }

        if (this.graph.hasNode(word)) {
            return { error: `"${word}" is already on the board.` };
        }

        // Ask glove.js which board words this new word connects to
        const connections = getConnections(word, this.graph.getBoardWords());

        // Add node and edges to the graph
        this.graph.addNode(word, connections);
        this.wordsAdded++;

        // Check win: is there a path from startWord to endWord?
        const won = this.graph.isConnected(this.startWord, this.endWord);

        if (won) {
            this.finished = true;
            const solveTime = this.getElapsed();

            // Highlight the winning path in green
            const path = this.graph.getPath(this.startWord, this.endWord);
            this.renderer.setWinningPath(path);

            this.onWin(this.wordsAdded, solveTime);
        }

        return { added: word, connections, won };
    }

    // ----------------------------------------------------------
    // saveResult
    // Writes the game outcome to Firebase.
    // Call this once per game after the win/loss is determined.
    // opponentElo should be passed for multiplayer; null for solo.
    // ----------------------------------------------------------
    async saveResult(won, opponentElo = null) {
        const user = await requireAuth();
        if (!user) return;
        await saveGameResult(user.uid, won, this.wordsAdded, this.getElapsed(), opponentElo);
    }

    // ----------------------------------------------------------
    // getElapsed
    // Seconds elapsed since init() was called.
    // ----------------------------------------------------------
    getElapsed() {
        if (!this._startTime) return 0;
        return Math.round((Date.now() - this._startTime) / 1000);
    }
}

// ============================================================
// pickTwoRandom
// Returns two distinct items chosen at random from arr.
// ============================================================
function pickTwoRandom(arr) {
    const i = Math.floor(Math.random() * arr.length);
    let   j = Math.floor(Math.random() * (arr.length - 1));
    if (j >= i) j++; // ensure j !== i
    return [arr[i], arr[j]];
}

// ============================================================
// pickStartEnd  (exported)
// Used by multiplayer.js so the host can generate a shared
// start/end pair and write it to Firebase for both players.
// ============================================================
export function pickStartEnd() {
    return pickTwoRandom(WORD_BANK);
}