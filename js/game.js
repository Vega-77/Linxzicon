// ============================================================\
// game.js
// Core game logic shared by solo and multiplayer.
// Includes graph processing and analytics metadata calculation.
// ============================================================\

import { Graph }          from "./graph.js";
import { getEngine }      from "./glove.js";
import { saveGameResult } from "./account.js";
import { requireAuth }    from "./auth.js";

export class GameSession {
    constructor(canvas, renderer, onWin, onMsg) {
        this.canvas   = canvas;
        this.renderer = renderer;
        this.onWin    = onWin;
        this.onMsg    = onMsg;

        this.graph      = null;
        this.engine     = null;
        this.startWord  = "";
        this.endWord    = "";
        this.wordsAdded = 0;
        this.isActive   = false;
        this._startTime = 0;
        
        // Track unique words submitted in the chronological order they were accepted
        this.wordsList  = []; 
    }

    async startSolo() {
        this.onMsg("Loading vocabulary...");
        this.engine = getEngine();
        
        const [w1, w2] = pickStartEnd();
        this.startWord = w1;
        this.endWord   = w2;

        this._setup(w1, w2);
        this.isActive = true;
        this.onMsg(`Connect ${w1.toUpperCase()} to ${w2.toUpperCase()}`);
    }

    startMultiplayerShared(startW, endW) {
        this.engine    = getEngine();
        this.startWord = startW;
        this.endWord   = endW;
        this._setup(startW, endW);
        this.isActive = true;
    }

    _setup(w1, w2) {
        this.graph = new Graph();
        this.graph.addNode(w1, []);
        this.graph.addNode(w2, []);

        const n1 = this.graph.nodes.get(w1);
        const n2 = this.graph.nodes.get(w2);
        n1.x = 200; n1.y = 300;
        n2.x = 600; n2.y = 300;

        this.wordsAdded = 0;
        this.wordsList  = [w1, w2];
        this._startTime = Date.now();

        this.renderer.attachGraph(this.graph, w1, w2);
    }

    async submitWord(rawWord) {
        if (!this.isActive) return { valid: false, reason: "Game not active" };

        const word = rawWord.trim().toLowerCase();
        if (!word) return { valid: false, reason: "Empty input" };

        if (this.graph.nodes.has(word)) {
            return { valid: false, reason: "Word already on board" };
        }

        if (!this.engine.hasWord(word)) {
            return { valid: false, reason: "Not in vocabulary" };
        }

        const boardWords = Array.from(this.graph.nodes.keys());
        const connections = [];

        for (const bw of boardWords) {
            const info = this.engine.pairSimilarity(word, bw);
            if (info && info.connected) {
                connections.push(bw);
            }
        }

        if (connections.length === 0) {
            return { valid: false, reason: "No connections found to existing words" };
        }

        this.graph.addNode(word, connections);
        this.wordsAdded++;
        if (!this.wordsList.includes(word)) {
            this.wordsList.push(word);
        }

        const path = this.graph.shortestPath(this.startWord, this.endWord);
        let won = false;

        if (path) {
            won = true;
            this.isActive = false;
            this.renderer.setWinningPath(path);
            
            // Collect advanced metadata metrics
            const extraData = {
                startWord:        this.startWord,
                endWord:          this.endWord,
                totalGraphWords:  this.graph.wordCount,
                bestPathLength:   path.length,
                actualPath:       path,
                wordsList:        [...this.wordsList],
                opponentUid:      "",
                opponentUsername: ""
            };

            const user = auth.currentUser;
            if (user) {
                await saveGameResult(
                    user.uid,
                    true,
                    this.wordsAdded,
                    this.getElapsed(),
                    null,
                    "solo",
                    extraData
                );
            }

            if (this.onWin) {
                this.onWin(this.wordsAdded, this.getElapsed());
            }
        }

        return { valid: true, won, connections };
    }

    getElapsed() {
        if (!this._startTime) return 0;
        return Math.round((Date.now() - this._startTime) / 1000);
    }
}

export function pickStartEnd() {
    const engine = getEngine();
    for (let attempt = 0; attempt < 3; attempt++) {
        const pool = engine.randomWords(30);
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

    const pool = engine.randomWords(20);
    for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
            const info = engine.pairSimilarity(pool[i], pool[j]);
            if (info && !info.isTrivial) return [pool[i], pool[j]];
        }
    }
    return engine.randomWords(2);
}