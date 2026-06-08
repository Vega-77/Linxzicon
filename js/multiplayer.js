// ============================================================\
// multiplayer.js
// Orchestrates real-time matching, tracking match metadata metrics.
// ============================================================\

import { database } from "./firebase-config.js";
import {
    ref, set, get, update, push,
    onValue, remove, serverTimestamp, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { requireAuth }    from "./auth.js";
import { loadAccount }    from "./account.js";
import { pickStartEnd }   from "./game.js";
import { saveGameResult } from "./account.js";

export class MultiplayerSession {
    constructor(renderer, gameSession,
                onMatchFound, onOpponentWord, onGameOver, onMessage,
                onRematchRequested) {
        this.renderer           = renderer;
        this.gameSession        = gameSession;
        this.onMatchFound       = onMatchFound;
        this.onOpponentWord     = onOpponentWord;
        this.onGameOver         = onGameOver;
        this.onMessage          = onMessage;
        this.onRematchRequested = onRematchRequested ?? null;

        this.gameId           = null;
        this.myUid            = null;
        this.myElo            = null;
        this.myUsername       = null;
        this.opponentUid      = null;
        this.opponentElo      = null;
        this.opponentUsername = null;
        this.finished         = false;

        this._gameOverFired   = false;
        this._rematchStarted  = false;
        this._unsubQueue      = null;
        this._unsubGame       = null;
        this._unsubRematch    = null;
    }

    async findMatch(uid, account) {
        this.myUid      = uid;
        this.myElo      = account.elo;
        this.myUsername = account.username;
        this.finished   = false;
        this._gameOverFired  = false;
        this._rematchStarted = false;

        this.onMessage("Searching for opponent...");

        const queueRef = ref(database, "queue");
        try {
            const snap = await get(queueRef);
            let opponentKey = null;
            let opponentVal = null;

            if (snap.exists()) {
                const players = snap.val();
                for (const k in players) {
                    if (k !== this.myUid) {
                        opponentKey = k;
                        opponentVal = players[k];
                        break;
                    }
                }
            }

            if (opponentKey) {
                const opQRef = ref(database, `queue/${opponentKey}`);
                try {
                    await remove(opQRef);
                } catch (e) {
                    console.log("[multi] Race condition caught, re-searching...");
                    setTimeout(() => this.findMatch(uid, account), 500);
                    return;
                }

                const newGameId = `game_${opponentKey}_${this.myUid}_${Date.now()}`;
                const [w1, w2]  = pickStartEnd();

                this.opponentUid      = opponentKey;
                this.opponentElo      = opponentVal.elo ?? 1000;
                this.opponentUsername = opponentVal.username ?? "Opponent";

                const gameData = {
                    gameId:       newGameId,
                    status:       "active",
                    hostUid:      opponentKey,
                    guestUid:     this.myUid,
                    startWord:    w1,
                    endWord:      w2,
                    createdAt:    serverTimestamp()
                };

                await set(ref(database, `games/${newGameId}`), gameData);
                await set(ref(database, `queue/${opponentKey}/matchedGameId`), newGameId);

                this.gameId = newGameId;
                this._initLocalBoard(w1, w2, this.opponentUsername);
                this._listenToGame();
                if (this.onMatchFound) this.onMatchFound(this.opponentUsername, this.opponentElo);

            } else {
                // Stand in line
                await set(ref(database, `queue/${this.myUid}`), {
                    username:  this.myUsername,
                    elo:       this.myElo,
                    createdAt: serverTimestamp()
                });

                const myQRef = ref(database, `queue/${this.myUid}/matchedGameId`);
                this._unsubQueue = onValue(myQRef, async (s) => {
                    if (!s.exists()) return;
                    if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }

                    this.gameId = s.val();
                    try {
                        const gSnap = await get(ref(database, `games/${this.gameId}`));
                        if (!gSnap.exists()) return;
                        const g = gSnap.val();

                        this.opponentUid = g.hostUid;
                        const opAcc = await loadAccount(this.opponentUid);
                        this.opponentElo      = opAcc ? opAcc.elo : 1000;
                        this.opponentUsername = opAcc ? opAcc.username : "Opponent";

                        this._initLocalBoard(g.startWord, g.endWord, this.opponentUsername);
                        this._listenToGame();
                        if (this.onMatchFound) this.onMatchFound(this.opponentUsername, this.opponentElo);
                    } catch (err) {
                        console.error("[multi] Failed loading match configuration profile details:", err);
                    }
                });
            }
        } catch (err) {
            console.error("[multi] Matchmaking processing failure:", err);
            this.onMessage("Matchmaking failed.");
        }
    }

    _initLocalBoard(w1, w2, oppName) {
        this.gameSession.startMultiplayerShared(w1, w2);
        this.onMessage(`Vs ${oppName.toUpperCase()} — Connect ${w1.toUpperCase()} to ${w2.toUpperCase()}`);
    }

    _listenToGame() {
        if (!this.gameId) return;
        const gRef = ref(database, `games/${this.gameId}`);

        this._unsubGame = onValue(gRef, (snap) => {
            if (!snap.exists()) return;
            const g = snap.val();

            // Opponent updates words
            const oppUid = (g.hostUid === this.myUid) ? g.guestUid : g.hostUid;
            if (g.lastWordAdded && g.lastWordBy === oppUid) {
                if (this.onOpponentWord) {
                    this.onOpponentWord(g.lastWordAdded);
                }
            }

            if (g.status === "finished" && !this._gameOverFired) {
                this._gameOverFired = true;
                this._handleGameOver(g.winner);
            }
        });
    }

    async submitWord(rawWord) {
        if (this.finished || !this.gameId) return { valid: false, reason: "Game concluded" };

        const result = await this.gameSession.submitWord(rawWord);
        if (result.valid) {
            await update(ref(database, `games/${this.gameId}`), {
                lastWordAdded: rawWord.trim().toLowerCase(),
                lastWordBy:    this.myUid
            });
        }

        if (result.won && !this.finished) {
            this.finished = true;
            await update(ref(database, `games/${this.gameId}`), {
                status: "finished",
                winner: this.myUid
            });

            const path = this.gameSession.graph.shortestPath(this.gameSession.startWord, this.gameSession.endWord);
            const extraData = {
                startWord:        this.gameSession.startWord,
                endWord:          this.gameSession.endWord,
                totalGraphWords:  this.gameSession.graph.wordCount,
                bestPathLength:   path ? path.length : 0,
                actualPath:       path ?? [],
                wordsList:        [...this.gameSession.wordsList],
                opponentUid:      this.opponentUid,
                opponentUsername: this.opponentUsername
            };

            await saveGameResult(
                this.myUid,
                true,
                this.gameSession.wordsAdded,
                this.gameSession.getElapsed(),
                this.opponentElo,
                "multiplayer",
                extraData
            );
        }

        return result;
    }

    async _handleGameOver(winnerUid) {
        this.finished = true;
        const iWon = (winnerUid === this.myUid);

        if (!iWon) {
            const path = this.gameSession.graph.shortestPath(this.gameSession.startWord, this.gameSession.endWord);
            const extraData = {
                startWord:        this.gameSession.startWord,
                endWord:          this.gameSession.endWord,
                totalGraphWords:  this.gameSession.graph.wordCount,
                bestPathLength:   path ? path.length : 0,
                actualPath:       path ?? [],
                wordsList:        [...this.gameSession.wordsList],
                opponentUid:      this.opponentUid,
                opponentUsername: this.opponentUsername
            };

            await saveGameResult(
                this.myUid,
                false,
                this.gameSession.wordsAdded,
                this.gameSession.getElapsed(),
                this.opponentElo,
                "multiplayer",
                extraData
            );
        }

        if (this.onGameOver) {
            this.onGameOver(iWon);
        }
        this._listenForRematches();
    }

    async requestRematch() {
        if (!this.gameId) return;
        try {
            await update(ref(database, `games/${this.gameId}`), {
                [`rematchRequested_${this.myUid}`]: true
            });

            const snap = await get(ref(database, `games/${this.gameId}`));
            if (!snap.exists()) return;
            const g = snap.val();

            const oppUid = (g.hostUid === this.myUid) ? g.guestUid : g.hostUid;
            if (g[`rematchRequested_${oppUid}`] && !this._rematchStarted) {
                this._rematchStarted = true;
                const nextGameId = `game_${this.gameId}_rematch_${Date.now()}`;
                const [w1, w2]   = pickStartEnd();

                await set(ref(database, `games/${nextGameId}`), {
                    gameId:       nextGameId,
                    status:       "active",
                    hostUid:      g.hostUid,
                    guestUid:     g.guestUid,
                    startWord:    w1,
                    endWord:      w2,
                    createdAt:    serverTimestamp()
                });

                await update(ref(database, `games/${this.gameId}`), {
                    rematchGameId: nextGameId
                });

                this.gameId = nextGameId;
                this._initLocalBoard(w1, w2, this.opponentUsername);
                this._listenToGame();
            }
        } catch (err) {
            console.error("[multi] Rematch initialization failed:", err);
        }
    }

    _listenForRematches() {
        if (!this.gameId) return;
        const gRef = ref(database, `games/${this.gameId}`);

        const oppUid = (this.myUid === this.opponentUid) ? "" : this.opponentUid;
        if (oppUid) {
            onValue(ref(database, `games/${this.gameId}/rematchRequested_${oppUid}`), (snap) => {
                if (snap.exists() && snap.val() === true) {
                    if (this.onRematchRequested) this.onRematchRequested();
                }
            });

            this._unsubRematch = onValue(ref(database, `games/${this.gameId}/rematchGameId`), async (snap) => {
                if (!snap.exists()) return;
                if (this._unsubRematch) { this._unsubRematch(); this._unsubRematch = null; }

                this.gameId = snap.val();

                try {
                    const gs = await get(ref(database, `games/${this.gameId}`));
                    if (!gs.exists()) return;
                    const g = gs.val();
                    this._initLocalBoard(g.startWord, g.endWord, this.opponentUsername);
                    this._listenToGame();
                } catch (err) {
                    console.error("[multi] Rematch tracking configuration read failure:", err);
                }
            });
        }
    }

    async cancelSearch() {
        if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }
        try { await remove(ref(database, `queue/${this.myUid}`)); } catch (_) {}
    }

    cleanup() {
        if (this._unsubGame)    { this._unsubGame();    this._unsubGame    = null; }
        if (this._unsubQueue)   { this._unsubQueue();   this._unsubQueue   = null; }
        if (this._unsubRematch) { this._unsubRematch(); this._unsubRematch = null; }
    }
}