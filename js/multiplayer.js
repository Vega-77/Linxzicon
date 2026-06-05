import { database } from "./firebase-config.js";
import {
    ref, set, get, update, push,
    onValue, remove, serverTimestamp
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
        this._rematchNotified = false;

        this._unsubGame  = null;
        this._unsubQueue = null;
    }

    // ----------------------------------------------------------
    // findMatch
    // ----------------------------------------------------------
    async findMatch() {
        console.log("[multi] findMatch starting");

        let user, account;
        try {
            user       = await requireAuth();
            this.myUid = user.uid;
            account    = await loadAccount(user.uid);
            console.log("[multi] auth OK uid:", this.myUid, "elo:", account?.elo,
                "username:", account?.username);
        } catch (err) {
            console.error("[multi] auth/loadAccount failed:", err);
            this.onMessage("Authentication error — see console.");
            return;
        }

        // Store my info for use in game-over and rematch flows
        this.myElo      = account?.elo      ?? 1000;
        this.myUsername = account?.username ?? "Player";

        this.onMessage("Looking for an opponent…");

        // ── Always remove our own stale entry first ──
        try {
            await remove(ref(database, `queue/${this.myUid}`));
            console.log("[multi] cleared own stale queue entry");
        } catch (_) {}

        // ── Read the queue and clean up stale entries ──
        let snap;
        try {
            snap = await get(ref(database, "queue"));
            console.log("[multi] queue exists:", snap.exists(),
                snap.exists() ? JSON.stringify(snap.val()).slice(0, 300) : "empty");
        } catch (err) {
            console.error("[multi] reading queue FAILED:", err);
            this.onMessage("Firebase read error — check DB rules.");
            return;
        }

        let bestKey = null, bestEntry = null, bestDiff = Infinity;

        if (snap.exists()) {
            for (const [key, entry] of Object.entries(snap.val())) {
                if (entry.uid === this.myUid) continue;

                if (entry.gameId) {
                    console.log("[multi] entry", entry.uid, "has stale gameId", entry.gameId,
                        "— checking if game is still active");
                    try {
                        const gameSnap = await get(
                            ref(database, `games/${entry.gameId}/status`));
                        if (!gameSnap.exists() || gameSnap.val() !== "active") {
                            console.log("[multi] stale game found, removing queue entry for",
                                entry.uid);
                            await remove(ref(database, `queue/${key}`));
                            continue;
                        }
                    } catch (_) {
                        await remove(ref(database, `queue/${key}`)).catch(() => {});
                        continue;
                    }
                    console.log("[multi] entry", entry.uid, "is actively in a game, skipping");
                    continue;
                }

                const diff = Math.abs((entry.elo ?? 1000) - this.myElo);
                if (diff < bestDiff) {
                    bestDiff  = diff;
                    bestKey   = key;
                    bestEntry = entry;
                }
            }
        }

        if (bestKey) {
            console.log("[multi] found opponent:", bestEntry.uid,
                "username:", bestEntry.username, "elo:", bestEntry.elo);
            try { await remove(ref(database, `queue/${bestKey}`)); } catch (_) {}
            await this._createGame(account, bestEntry);
            return;
        }

        // No opponent — write self and wait
        console.log("[multi] no opponent found, writing self to queue");
        try {
            await set(ref(database, `queue/${this.myUid}`), {
                uid:      this.myUid,
                elo:      this.myElo,
                username: this.myUsername,
                joinedAt: serverTimestamp(),
                gameId:   null
            });
            console.log("[multi] wrote self to queue");
        } catch (err) {
            console.error("[multi] writing to queue FAILED:", err);
            this.onMessage("Firebase write error — check DB rules.");
            return;
        }

        this.onMessage("Waiting for opponent… (open a 2nd tab at the same URL to test)");
        this._waitForGame();
    }

    // ----------------------------------------------------------
    // _createGame — host
    // ----------------------------------------------------------
    async _createGame(myAccount, opponent) {
        console.log("[multi] _createGame host:", myAccount.uid,
            "username:", myAccount.username,
            "guest:", opponent.uid, "username:", opponent.username);

        const [startWord, endWord] = pickStartEnd();
        console.log("[multi] word pair:", startWord, "→", endWord);

        const gameRef = push(ref(database, "games"));
        this.gameId   = gameRef.key;
        console.log("[multi] gameId:", this.gameId);

        const opponentUsername = opponent.username ?? "Opponent";

        this.opponentUid      = opponent.uid;
        this.opponentElo      = opponent.elo ?? 1000;
        this.opponentUsername = opponentUsername;

        try {
            await set(gameRef, {
                startWord,
                endWord,
                status:    "active",
                winner:    null,
                createdAt: serverTimestamp(),
                players: {
                    [myAccount.uid]: {
                        username: this.myUsername,
                        elo:      this.myElo,
                        words:    {}
                    },
                    [opponent.uid]: {
                        username: opponentUsername,
                        elo:      this.opponentElo,
                        words:    {}
                    }
                }
            });
            console.log("[multi] game doc written OK");
        } catch (err) {
            console.error("[multi] writing game doc FAILED:", err);
            this.onMessage("Firebase write error — check DB rules.");
            return;
        }

        // Signal the guest by writing gameId into their queue slot
        try {
            await set(ref(database, `queue/${opponent.uid}`), {
                uid:      opponent.uid,
                elo:      this.opponentElo,
                username: opponentUsername,
                gameId:   this.gameId
            });
            console.log("[multi] notified guest with gameId");
        } catch (err) {
            console.error("[multi] notifying guest FAILED:", err);
        }

        this._initLocalBoard(startWord, endWord, opponentUsername);
        this._listenToGame();
    }

    // ----------------------------------------------------------
    // _waitForGame — guest watches their own queue slot
    // ----------------------------------------------------------
    _waitForGame() {
        console.log("[multi] _waitForGame listening to /queue/" + this.myUid);
        const myQueueRef = ref(database, `queue/${this.myUid}`);

        this._unsubQueue = onValue(myQueueRef, async (snap) => {
            console.log("[multi] queue slot update exists:", snap.exists(),
                snap.exists() ? JSON.stringify(snap.val()) : "null");

            if (!snap.exists()) return;
            const data = snap.val();
            if (!data.gameId) { console.log("[multi] no gameId yet, waiting…"); return; }

            const gameId = data.gameId;
            this.gameId  = gameId;
            console.log("[multi] got gameId:", gameId);

            if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }
            try { await remove(myQueueRef); } catch (_) {}

            // Load the full game document
            let gameSnap;
            try {
                gameSnap = await get(ref(database, `games/${gameId}`));
                console.log("[multi] game doc exists:", gameSnap.exists(),
                    gameSnap.exists()
                        ? JSON.stringify(gameSnap.val()).slice(0, 300)
                        : "null");
            } catch (err) {
                console.error("[multi] loading game doc FAILED:", err);
                return;
            }

            if (!gameSnap.exists()) {
                console.error("[multi] game doc not found for id:", gameId);
                return;
            }

            const game = gameSnap.val();

            for (const uid of Object.keys(game.players ?? {})) {
                if (uid !== this.myUid) {
                    this.opponentUid      = uid;
                    this.opponentElo      = game.players[uid].elo ?? 1000;
                    this.opponentUsername = game.players[uid].username ?? "Opponent";
                    console.log("[multi] opponent:", uid,
                        "username:", this.opponentUsername,
                        "elo:", this.opponentElo);
                }
            }

            if (!this.opponentUid) {
                console.error("[multi] could not find opponent UID in game doc");
                return;
            }

            this._initLocalBoard(game.startWord, game.endWord, this.opponentUsername);
            this._listenToGame();
        });
    }

    // ----------------------------------------------------------
    // _initLocalBoard
    // ----------------------------------------------------------
    _initLocalBoard(startWord, endWord, opponentName) {
        console.log("[multi] _initLocalBoard:", startWord, "→", endWord, "vs", opponentName);
        this.gameSession.initWords(startWord, endWord);
        this.onMatchFound({ gameId: this.gameId, startWord, endWord, opponentName });
    }

    // ----------------------------------------------------------
    // _listenToGame
    // ----------------------------------------------------------
    _listenToGame() {
        console.log("[multi] _listenToGame gameId:", this.gameId);
        const seenOpponentWords = new Set();

        this._unsubGame = onValue(ref(database, `games/${this.gameId}`), (snap) => {
            if (!snap.exists()) { console.warn("[multi] game doc gone"); return; }
            const game         = snap.val();
            const opponentData = game.players?.[this.opponentUid];

            // Firebase stores push()-ed words as a numeric-keyed object, not array
            const words = opponentData?.words
                ? Object.values(opponentData.words)
                : [];

            for (const word of words) {
                if (!seenOpponentWords.has(word)) {
                    seenOpponentWords.add(word);
                    console.log("[multi] opponent word:", word);
                    this.onOpponentWord(word);
                }
            }

            // Game-over detection — use _gameOverFired so winner (who set finished=true
            // in submitWord before Firebase echoed back) still gets this block exactly once
            if (game.status === "finished" && !this._gameOverFired) {
                this._gameOverFired = true;
                const iWon = game.winner === this.myUid;
                console.log("[multi] game over, won:", iWon);
                // Winner already called onGameOver immediately in submitWord;
                // only fire here for the loser
                if (!this.finished) {
                    this.finished = true;
                    this.onGameOver({ won: iWon, opponentElo: this.opponentElo, myElo: this.myElo });
                }
            }

            // Rematch detection — keep listening after game ends
            if (game.status === "finished") {
                const r = game.rematch ?? {};
                if (r[this.myUid] && r[this.opponentUid] && !this._rematchStarted) {
                    this._rematchStarted = true;
                    this._startRematch();
                } else if (r[this.opponentUid] && !r[this.myUid] && !this._rematchNotified) {
                    this._rematchNotified = true;
                    this.onRematchRequested?.();
                }
            }
        });
    }

    // ----------------------------------------------------------
    // submitWord
    // ----------------------------------------------------------
    async submitWord(rawInput) {
        if (this.finished) return { error: "Game is already over." };

        const result = this.gameSession.submitWord(rawInput);
        if (result.error) return result;

        console.log("[multi] submitWord:", result.added,
            "connections:", result.connections);

        try {
            const wordsRef = ref(database,
                `games/${this.gameId}/players/${this.myUid}/words`);
            await push(wordsRef, result.added);
            console.log("[multi] word pushed to Firebase");
        } catch (err) {
            console.error("[multi] word push FAILED:", err);
        }

        if (result.won) {
            this.finished = true;
            // Show the winner's overlay immediately without waiting for Firebase round-trip
            this.onGameOver({ won: true, opponentElo: this.opponentElo, myElo: this.myElo });
            try {
                await update(ref(database, `games/${this.gameId}`), {
                    status: "finished",
                    winner: this.myUid
                });
                console.log("[multi] marked game finished");
            } catch (err) {
                console.error("[multi] marking finished FAILED:", err);
            }
            await saveGameResult(
                this.myUid, true,
                this.gameSession.wordsAdded,
                this.gameSession.getElapsed(),
                this.opponentElo
            );
        }

        return result;
    }

    // ----------------------------------------------------------
    // requestRematch
    // ----------------------------------------------------------
    async requestRematch() {
        if (!this.gameId) return;
        console.log("[multi] requestRematch");
        try {
            await set(ref(database, `games/${this.gameId}/rematch/${this.myUid}`), true);
        } catch (err) {
            console.error("[multi] requestRematch FAILED:", err);
        }
    }

    // ----------------------------------------------------------
    // _startRematch
    // ----------------------------------------------------------
    async _startRematch() {
        const oldGameId = this.gameId;
        console.log("[multi] _startRematch from game:", oldGameId);

        // Unsubscribe from old game listener first
        if (this._unsubGame) { this._unsubGame(); this._unsubGame = null; }

        // Reset state for the new game
        this._gameOverFired   = false;
        this._rematchStarted  = false;
        this._rematchNotified = false;
        this.finished         = false;

        const isHost = this.myUid < this.opponentUid;

        if (isHost) {
            const [sw, ew] = pickStartEnd();
            const gameRef  = push(ref(database, "games"));
            this.gameId    = gameRef.key;
            console.log("[multi] rematch host creating game:", this.gameId);

            try {
                await set(gameRef, {
                    startWord: sw,
                    endWord:   ew,
                    status:    "active",
                    winner:    null,
                    createdAt: serverTimestamp(),
                    players: {
                        [this.myUid]: {
                            username: this.myUsername,
                            elo:      this.myElo,
                            words:    {}
                        },
                        [this.opponentUid]: {
                            username: this.opponentUsername,
                            elo:      this.opponentElo,
                            words:    {}
                        }
                    }
                });
                // Write new game ID to old game doc so guest can find it
                await update(ref(database, `games/${oldGameId}`), { rematchGameId: this.gameId });
                console.log("[multi] rematch game created, notified guest");
            } catch (err) {
                console.error("[multi] rematch game creation FAILED:", err);
                return;
            }

            this._initLocalBoard(sw, ew, this.opponentUsername);
            this._listenToGame();

        } else {
            // Guest: watch old game doc for rematchGameId written by host
            console.log("[multi] rematch guest waiting for new gameId");
            const unsub = onValue(ref(database, `games/${oldGameId}/rematchGameId`), async (snap) => {
                if (!snap.exists()) return;
                unsub();

                this.gameId = snap.val();
                console.log("[multi] rematch guest got new gameId:", this.gameId);

                try {
                    const gs = await get(ref(database, `games/${this.gameId}`));
                    if (!gs.exists()) {
                        console.error("[multi] rematch game doc not found");
                        return;
                    }
                    const g = gs.val();
                    this._initLocalBoard(g.startWord, g.endWord, this.opponentUsername);
                    this._listenToGame();
                } catch (err) {
                    console.error("[multi] rematch guest join FAILED:", err);
                }
            });
        }
    }

    // ----------------------------------------------------------
    // cancelSearch / cleanup
    // ----------------------------------------------------------
    async cancelSearch() {
        console.log("[multi] cancelSearch");
        if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }
        try { await remove(ref(database, `queue/${this.myUid}`)); } catch (_) {}
    }

    cleanup() {
        console.log("[multi] cleanup");
        if (this._unsubGame)  { this._unsubGame();  this._unsubGame  = null; }
        if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }
    }
}
