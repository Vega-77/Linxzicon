// ============================================================
// multiplayer.js
// Real-time multiplayer via Firebase Realtime Database.
//
// MATCHMAKING FLOW:
//   1. Player clicks "Find Match" → findMatch() is called
//   2. We read /queue for a waiting player
//   3a. Someone waiting → remove them, create /games/{id}, start
//   3b. Nobody waiting  → write ourselves to /queue, listen
//   4. Both clients subscribe to /games/{id} with onValue
//   5. Each word submission writes to the game doc
//   6. The first player whose local graph becomes connected
//      sets status="finished" and winner=theirUID in Firebase
//   7. onGameOver fires on both clients; each saves their own result
//
// IMPORTANT: Each client only writes its OWN result to Firebase.
// The winner saves a win; the loser saves a loss. This avoids one
// client writing incorrect stats for the other player.
// ============================================================

import { database }                        from "./firebase-config.js";
import {
    ref, set, get, update, push,
    onValue, remove, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { requireAuth }     from "./auth.js";
import { loadAccount }     from "./account.js";
import { pickStartEnd }    from "./game.js";
import { saveGameResult }  from "./account.js";

// ============================================================
// MultiplayerSession
// Manages the live multiplayer state for the local player.
// Wraps a GameSession for local graph/word logic.
// ============================================================
export class MultiplayerSession {
    // renderer        — Renderer from render.js
    // gameSession     — GameSession from game.js
    // onMatchFound    — callback({ gameId, startWord, endWord, opponentName })
    // onOpponentWord  — callback(word: string)
    // onGameOver      — callback({ won: bool, opponentElo: number })
    // onMessage       — callback(text: string) for matchmaking status text
    constructor(renderer, gameSession,
                onMatchFound, onOpponentWord, onGameOver, onMessage) {
        this.renderer       = renderer;
        this.gameSession    = gameSession;
        this.onMatchFound   = onMatchFound;
        this.onOpponentWord = onOpponentWord;
        this.onGameOver     = onGameOver;
        this.onMessage      = onMessage;

        this.gameId       = null;
        this.myUid        = null;
        this.opponentUid  = null;
        this.opponentElo  = null;
        this.finished     = false;

        this._unsubGame   = null; // unsubscribe fn for /games listener
        this._unsubQueue  = null; // unsubscribe fn for /games queue-wait listener
    }

    // ----------------------------------------------------------
    // findMatch
    // Entry point. Checks the queue and either creates a game
    // immediately or waits for an opponent.
    // ----------------------------------------------------------
    async findMatch() {
        const user    = await requireAuth();
        this.myUid    = user.uid;
        const account = await loadAccount(user.uid);

        this.onMessage("Looking for an opponent…");

        const snapshot = await get(ref(database, "queue"));

        if (snapshot.exists()) {
            const entries = Object.entries(snapshot.val());

            // Find the queued player with the closest Elo (excluding ourselves)
            let bestKey   = null;
            let bestEntry = null;
            let bestDiff  = Infinity;

            for (const [key, entry] of entries) {
                if (entry.uid === this.myUid) continue;
                const diff = Math.abs(entry.elo - account.elo);
                if (diff < bestDiff) {
                    bestDiff  = diff;
                    bestKey   = key;
                    bestEntry = entry;
                }
            }

            if (bestKey) {
                // Found an opponent — remove them from queue and start game
                await remove(ref(database, `queue/${bestKey}`));
                await this._createGame(account, bestEntry);
                return;
            }
        }

        // No opponent found — add ourselves to the queue and wait
        await set(ref(database, `queue/${this.myUid}`), {
            uid:      this.myUid,
            elo:      account.elo,
            username: account.username,
            joinedAt: serverTimestamp()
        });

        this._waitForGame();
    }

    // ----------------------------------------------------------
    // _createGame
    // Called by the "host" player (the one who found the match).
    // Writes the game document to /games/{autoId}.
    // ----------------------------------------------------------
    async _createGame(myAccount, opponent) {
        const [startWord, endWord] = pickStartEnd();
        const gameRef = push(ref(database, "games")); // auto-generate game ID
        this.gameId   = gameRef.key;

        await set(gameRef, {
            startWord,
            endWord,
            status:    "active",           // "active" | "finished"
            winner:    null,
            createdAt: serverTimestamp(),
            players: {
                [myAccount.uid]: {
                    username: myAccount.username,
                    elo:      myAccount.elo,
                    words:    []           // words this player has added
                },
                [opponent.uid]: {
                    username: opponent.username,
                    elo:      opponent.elo,
                    words:    []
                }
            }
        });

        this.opponentUid = opponent.uid;
        this.opponentElo = opponent.elo;

        this._initLocalBoard(startWord, endWord, opponent.username);
        this._listenToGame();
    }

    // ----------------------------------------------------------
    // _waitForGame
    // Subscribes to /games and waits until a document appears
    // that includes our UID as a player.
    // ----------------------------------------------------------
    _waitForGame() {
        this._unsubQueue = onValue(ref(database, "games"), (snapshot) => {
            if (!snapshot.exists()) return;

            for (const [gameId, game] of Object.entries(snapshot.val())) {
                // Only care about active games that include us
                if (game.status !== "active") continue;
                if (!game.players?.[this.myUid]) continue;

                this.gameId = gameId;

                // Identify the opponent
                for (const uid of Object.keys(game.players)) {
                    if (uid !== this.myUid) {
                        this.opponentUid = uid;
                        this.opponentElo = game.players[uid].elo;
                    }
                }

                // Stop the queue listener — we found our game
                if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }

                // Remove ourselves from the queue
                remove(ref(database, `queue/${this.myUid}`));

                const opponentName = game.players[this.opponentUid].username;
                this._initLocalBoard(game.startWord, game.endWord, opponentName);
                this._listenToGame();
                return;
            }
        });
    }

    // ----------------------------------------------------------
    // _initLocalBoard
    // Shared setup between host and guest.
    // Seeds the local GameSession with the agreed start/end words.
    // ----------------------------------------------------------
    _initLocalBoard(startWord, endWord, opponentName) {
        this.gameSession.graph = this.gameSession.graph.constructor
            ? new (this.gameSession.graph.constructor)()
            : this.gameSession.graph;

        // Directly add the two starting nodes (no glove lookup needed)
        this.gameSession.graph.addNode(startWord, []);
        this.gameSession.graph.addNode(endWord,   []);
        this.gameSession.startWord  = startWord;
        this.gameSession.endWord    = endWord;
        this.gameSession._startTime = Date.now();
        this.gameSession.finished   = false;
        this.gameSession.wordsAdded = 0;

        this.renderer.graph = this.gameSession.graph;
        this.renderer.setStartEnd(startWord, endWord);
        this.renderer.setWinningPath(null);
        this.renderer.start();

        this.onMatchFound({ gameId: this.gameId, startWord, endWord, opponentName });
    }

    // ----------------------------------------------------------
    // _listenToGame
    // Subscribes to the game document.
    // Detects opponent word additions and game-over events.
    // ----------------------------------------------------------
    _listenToGame() {
        // Track which opponent words we have already processed
        // so we don't re-fire onOpponentWord on every DB update
        const seenOpponentWords = new Set();

        this._unsubGame = onValue(ref(database, `games/${this.gameId}`), (snapshot) => {
            if (!snapshot.exists()) return;
            const game         = snapshot.val();
            const opponentData = game.players?.[this.opponentUid];

            // ── Sync new opponent words ──
            if (opponentData?.words) {
                for (const word of opponentData.words) {
                    if (!seenOpponentWords.has(word)) {
                        seenOpponentWords.add(word);
                        this.onOpponentWord(word);
                    }
                }
            }

            // ── Game over ──
            if (game.status === "finished" && !this.finished) {
                this.finished = true;
                if (this._unsubGame) { this._unsubGame(); this._unsubGame = null; }

                const iWon = game.winner === this.myUid;
                this.onGameOver({ won: iWon, opponentElo: this.opponentElo });
            }
        });
    }

    // ----------------------------------------------------------
    // submitWord
    // Submits a word for the local player.
    // Runs local game logic first, then syncs to Firebase.
    // If this word wins the game, marks the game finished in DB.
    // ----------------------------------------------------------
    async submitWord(rawInput) {
        if (this.finished) return { error: "Game is already over." };

        const result = this.gameSession.submitWord(rawInput);
        if (result.error) return result;

        // Append the new word to our player entry in Firebase
        const playerWordsRef = ref(database,
            `games/${this.gameId}/players/${this.myUid}/words`);
        const snap        = await get(playerWordsRef);
        const currentList = snap.exists() ? snap.val() : [];
        currentList.push(result.added);
        await set(playerWordsRef, currentList);

        // If we just won, write the result to the game document.
        // The onValue listener on both clients will then fire onGameOver.
        if (result.won) {
            this.finished = true;
            await update(ref(database, `games/${this.gameId}`), {
                status: "finished",
                winner: this.myUid
            });

            // Save OUR win. The opponent saves their own loss in onGameOver.
            await saveGameResult(
                this.myUid,
                true,
                this.gameSession.wordsAdded,
                this.gameSession.getElapsed(),
                this.opponentElo
            );
        }

        return result;
    }

    // ----------------------------------------------------------
    // cancelSearch
    // Removes us from the queue. Call if the user cancels.
    // ----------------------------------------------------------
    async cancelSearch() {
        if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }
        await remove(ref(database, `queue/${this.myUid}`));
    }

    // ----------------------------------------------------------
    // cleanup
    // Unsubscribes all Firebase listeners.
    // Call in a beforeunload handler or when leaving the page.
    // ----------------------------------------------------------
    cleanup() {
        if (this._unsubGame)  { this._unsubGame();  this._unsubGame  = null; }
        if (this._unsubQueue) { this._unsubQueue(); this._unsubQueue = null; }
    }
}