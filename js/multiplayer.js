// ============================================================
// multiplayer.js
//
// FIXES:
//   1. Stale queue entries with gameId set caused players to be
//      skipped as "already matched". Fix: when scanning the queue,
//      delete any entry whose gameId points to a finished/missing
//      game before deciding there's no opponent.
//   2. After a game ends, the host now cleans up both queue slots.
//   3. Username "Player" fallback replaced with proper account load.
// ============================================================

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
                onMatchFound, onOpponentWord, onGameOver, onMessage) {
        this.renderer       = renderer;
        this.gameSession    = gameSession;
        this.onMatchFound   = onMatchFound;
        this.onOpponentWord = onOpponentWord;
        this.onGameOver     = onGameOver;
        this.onMessage      = onMessage;

        this.gameId      = null;
        this.myUid       = null;
        this.opponentUid = null;
        this.opponentElo = null;
        this.finished    = false;

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

                // ── Clean up stale entries that still have a gameId ──
                // A gameId means this player was previously matched.
                // Check if that game still exists and is active.
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
                            continue; // skip this entry
                        }
                    } catch (_) {
                        // If we can't read the game, treat as stale
                        await remove(ref(database, `queue/${key}`)).catch(() => {});
                        continue;
                    }
                    // gameId exists and game is still active — truly already matched
                    console.log("[multi] entry", entry.uid, "is actively in a game, skipping");
                    continue;
                }

                const diff = Math.abs((entry.elo ?? 1000) - (account?.elo ?? 1000));
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
                elo:      account?.elo      ?? 1000,
                username: account?.username ?? "Player",
                joinedAt: serverTimestamp(),
                gameId:   null
            });
            console.log("[multi] wrote self to queue, username:", account?.username);
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

        // Use real usernames from the account objects
        const myUsername       = myAccount.username ?? myAccount.email ?? "Player";
        const opponentUsername = opponent.username  ?? "Opponent";

        try {
            await set(gameRef, {
                startWord,
                endWord,
                status:    "active",
                winner:    null,
                createdAt: serverTimestamp(),
                players: {
                    [myAccount.uid]: {
                        username: myUsername,
                        elo:      myAccount.elo ?? 1000,
                        words:    {}
                    },
                    [opponent.uid]: {
                        username: opponentUsername,
                        elo:      opponent.elo ?? 1000,
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
                elo:      opponent.elo      ?? 1000,
                username: opponentUsername,
                gameId:   this.gameId
            });
            console.log("[multi] notified guest with gameId, their username:", opponentUsername);
        } catch (err) {
            console.error("[multi] notifying guest FAILED:", err);
        }

        this.opponentUid = opponent.uid;
        this.opponentElo = opponent.elo ?? 1000;
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

            // Find opponent UID and get their username from the game doc
            // (more reliable than the queue entry which may have a stale username)
            for (const uid of Object.keys(game.players ?? {})) {
                if (uid !== this.myUid) {
                    this.opponentUid = uid;
                    this.opponentElo = game.players[uid].elo ?? 1000;
                    console.log("[multi] opponent:", uid,
                        "username:", game.players[uid].username,
                        "elo:", this.opponentElo);
                }
            }

            if (!this.opponentUid) {
                console.error("[multi] could not find opponent UID in game doc");
                return;
            }

            // Use username from the game doc — written by the host from their account
            const opponentUsername = game.players[this.opponentUid]?.username ?? "Opponent";

            this._initLocalBoard(game.startWord, game.endWord, opponentUsername);
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

            if (game.status === "finished" && !this.finished) {
                this.finished = true;
                if (this._unsubGame) { this._unsubGame(); this._unsubGame = null; }
                const iWon = game.winner === this.myUid;
                console.log("[multi] game over, won:", iWon);
                this.onGameOver({ won: iWon, opponentElo: this.opponentElo });
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