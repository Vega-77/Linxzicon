// ============================================================
// multiplayer.js
// Real-time multiplayer via Firebase Realtime Database.
//
// BUG FIXED: _waitForGame was listening to the entire /games
// node which fires on every update to every game forever.
// Now we listen to /queue/{myUid} for a "gameId" field that
// the host writes when it creates the game, which is a much
// more targeted listener and eliminates the infinite-loop hang.
//
// FLOW:
//   Host path:  findMatch → _createGame → _listenToGame
//   Guest path: findMatch → write to queue → _waitForGame
//               → host writes gameId into /queue/{guestUid}
//               → guest reads it → _listenToGame
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

        this._unsubGame  = null;  // /games/{id} listener
        this._unsubQueue = null;  // /queue/{myUid} listener (guest waiting)
    }

    // ----------------------------------------------------------
    // findMatch — entry point
    // ----------------------------------------------------------
    async findMatch() {
        const user    = await requireAuth();
        this.myUid    = user.uid;
        const account = await loadAccount(user.uid);

        this.onMessage("Looking for an opponent…");

        // Clean up any stale queue entry from a previous session
        await remove(ref(database, `queue/${this.myUid}`));

        const snap = await get(ref(database, "queue"));

        if (snap.exists()) {
            const entries = Object.entries(snap.val());

            let bestKey   = null;
            let bestEntry = null;
            let bestDiff  = Infinity;

            for (const [key, entry] of entries) {
                // Skip ourselves and entries that already have a gameId assigned
                if (entry.uid === this.myUid) continue;
                if (entry.gameId) continue; // already matched
                const diff = Math.abs((entry.elo ?? 1000) - account.elo);
                if (diff < bestDiff) { bestDiff = diff; bestKey = key; bestEntry = entry; }
            }

            if (bestKey && bestEntry) {
                await remove(ref(database, `queue/${bestKey}`));
                await this._createGame(account, bestEntry);
                return;
            }
        }

        // No match — write ourselves and wait
        await set(ref(database, `queue/${this.myUid}`), {
            uid:      this.myUid,
            elo:      account.elo,
            username: account.username,
            joinedAt: serverTimestamp(),
            gameId:   null   // host will fill this in
        });

        this._waitForGame();
    }

    // ----------------------------------------------------------
    // _createGame — host creates the game document, then notifies
    // the guest by writing the gameId into their queue entry.
    // ----------------------------------------------------------
    async _createGame(myAccount, opponent) {
        const [startWord, endWord] = pickStartEnd();
        const gameRef = push(ref(database, "games"));
        this.gameId   = gameRef.key;

        await set(gameRef, {
            startWord,
            endWord,
            status:    "active",
            winner:    null,
            createdAt: serverTimestamp(),
            players: {
                [myAccount.uid]: {
                    username: myAccount.username,
                    elo:      myAccount.elo,
                    words:    []
                },
                [opponent.uid]: {
                    username: opponent.username,
                    elo:      opponent.elo,
                    words:    []
                }
            }
        });

        // Tell the guest which game they are in
        await set(ref(database, `queue/${opponent.uid}`), {
            uid:      opponent.uid,
            elo:      opponent.elo ?? 1000,
            username: opponent.username ?? "",
            gameId:   this.gameId   // <-- guest watches for this
        });

        this.opponentUid = opponent.uid;
        this.opponentElo = opponent.elo ?? 1000;

        this._initLocalBoard(startWord, endWord, opponent.username);
        this._listenToGame();
    }

    // ----------------------------------------------------------
    // _waitForGame — guest listens to their OWN queue entry.
    // When the host writes a gameId into it, we start.
    // ----------------------------------------------------------
    _waitForGame() {
        const myQueueRef = ref(database, `queue/${this.myUid}`);

        this._unsubQueue = onValue(myQueueRef, async (snap) => {
            if (!snap.exists()) return;
            const data = snap.val();
            if (!data.gameId) return; // host hasn't matched us yet

            const gameId = data.gameId;
            this.gameId  = gameId;

            // Stop watching the queue
            if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }
            await remove(myQueueRef);

            // Load the game document to find the opponent
            const gameSnap = await get(ref(database, `games/${gameId}`));
            if (!gameSnap.exists()) return;
            const game = gameSnap.val();

            for (const uid of Object.keys(game.players ?? {})) {
                if (uid !== this.myUid) {
                    this.opponentUid = uid;
                    this.opponentElo = game.players[uid].elo ?? 1000;
                }
            }

            this._initLocalBoard(
                game.startWord,
                game.endWord,
                game.players[this.opponentUid]?.username ?? "Opponent"
            );
            this._listenToGame();
        });
    }

    // ----------------------------------------------------------
    // _initLocalBoard — shared setup for host and guest
    // ----------------------------------------------------------
    _initLocalBoard(startWord, endWord, opponentName) {
        this.gameSession.initWords(startWord, endWord);
        this.onMatchFound({ gameId: this.gameId, startWord, endWord, opponentName });
    }

    // ----------------------------------------------------------
    // _listenToGame — watch /games/{id} for opponent words + game over
    // ----------------------------------------------------------
    _listenToGame() {
        const seenOpponentWords = new Set();

        this._unsubGame = onValue(ref(database, `games/${this.gameId}`), (snap) => {
            if (!snap.exists()) return;
            const game         = snap.val();
            const opponentData = game.players?.[this.opponentUid];

            // New opponent words
            if (Array.isArray(opponentData?.words)) {
                for (const word of opponentData.words) {
                    if (!seenOpponentWords.has(word)) {
                        seenOpponentWords.add(word);
                        this.onOpponentWord(word);
                    }
                }
            }

            // Game over
            if (game.status === "finished" && !this.finished) {
                this.finished = true;
                if (this._unsubGame) { this._unsubGame(); this._unsubGame = null; }
                const iWon = game.winner === this.myUid;
                this.onGameOver({ won: iWon, opponentElo: this.opponentElo });
            }
        });
    }

    // ----------------------------------------------------------
    // submitWord — local logic + Firebase sync
    // ----------------------------------------------------------
    async submitWord(rawInput) {
        if (this.finished) return { error: "Game is already over." };

        const result = this.gameSession.submitWord(rawInput);
        if (result.error) return result;

        // Append word to our list in Firebase
        const wordsRef = ref(database, `games/${this.gameId}/players/${this.myUid}/words`);
        const snap     = await get(wordsRef);
        const list     = snap.exists() ? snap.val() : [];
        list.push(result.added);
        await set(wordsRef, list);

        if (result.won) {
            this.finished = true;
            await update(ref(database, `games/${this.gameId}`), {
                status: "finished",
                winner: this.myUid
            });
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
        if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }
        await remove(ref(database, `queue/${this.myUid}`));
    }

    cleanup() {
        if (this._unsubGame)  { this._unsubGame();  this._unsubGame  = null; }
        if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }
    }
}