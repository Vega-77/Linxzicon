import { database } from "./firebase-config.js";
import {
    ref, set, get, update, push,
    onValue, remove, serverTimestamp, runTransaction, onDisconnect
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { requireAuth }    from "./auth.js";
import { loadAccount }    from "./account.js";
import { pickStartEnd }   from "./game.js";
import { saveGameResult } from "./account.js";
import { getConfig }      from "./game-config.js";
import { isValidPairWord } from "./word-filter.js";

const QUEUE_STALE_MS = 90_000; // skip queue entries older than 90 s

export class MultiplayerSession {
    constructor(renderer, gameSession,
                onMatchFound, onOpponentWord, onGameOver, onMessage,
                onRematchRequested,
                onHintGranted,   // (word, connectedTo) => void
                onSkipGranted) { // () => void — optional; onMatchFound re-fires anyway
        this.renderer           = renderer;
        this.gameSession        = gameSession;
        this.onMatchFound       = onMatchFound;
        this.onOpponentWord     = onOpponentWord;
        this.onGameOver         = onGameOver;
        this.onMessage          = onMessage;
        this.onRematchRequested = onRematchRequested ?? null;
        this.onHintGranted      = onHintGranted      ?? null;
        this.onSkipGranted      = onSkipGranted      ?? null;

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
        this._hintGranted     = false;
        this._hintDelivered   = false;
        this._skipGranted     = false;

        this._unsubGame      = null;
        this._unsubQueue     = null;
        this._unsubQueueScan = null;
        this._unsubRematch   = null;
        this._disconnectRef  = null;
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
        } catch (err) {
            console.error("[multi] auth/loadAccount failed:", err);
            this.onMessage("Authentication error — see console.");
            return;
        }

        // Store my info for use in game-over and rematch flows
        this.myElo      = account?.elo      ?? 1000;
        this.myUsername = account?.username ?? "Player";
        this._myAccount = account;

        this.onMessage("Looking for an opponent…");

        // ── Always remove our own stale entry first ──
        try {
            await remove(ref(database, `queue/${this.myUid}`));
        } catch (_) {}

        // ── Read the queue and clean up stale entries ──
        let snap;
        try {
            snap = await get(ref(database, "queue"));
        } catch (err) {
            console.error("[multi] reading queue FAILED:", err);
            this.onMessage("Firebase read error — check DB rules.");
            return;
        }

        let bestKey = null, bestEntry = null, bestDiff = Infinity;
        const now = Date.now();

        if (snap.exists()) {
            for (const [key, entry] of Object.entries(snap.val())) {
                if (entry.uid === this.myUid) continue;

                // Skip entries that are too old (player likely navigated away)
                if (entry.joinedAtMs && (now - entry.joinedAtMs) > QUEUE_STALE_MS) {
                    await remove(ref(database, `queue/${key}`)).catch(() => {});
                    continue;
                }

                if (entry.gameId) {
                    try {
                        const gameSnap = await get(
                            ref(database, `games/${entry.gameId}/status`));
                        if (!gameSnap.exists() || gameSnap.val() !== "active") {
                            await remove(ref(database, `queue/${key}`));
                            continue;
                        }
                    } catch (_) {
                        await remove(ref(database, `queue/${key}`)).catch(() => {});
                        continue;
                    }
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
            // Atomically claim the opponent's queue slot to prevent two hosts racing for the same player
            let committed = false;
            try {
                const result = await runTransaction(ref(database, `queue/${bestKey}`), (current) => {
                    if (!current || current.gameId) return; // already taken — abort
                    return null; // claim by deleting
                });
                committed = result.committed;
            } catch (_) {}

            if (committed) {
                await this._createGame(account, bestEntry);
                return;
            }
            // Slot was taken by another host — fall through to queue
            console.log("[multi] opponent slot already claimed, entering queue");
        }

        // No opponent — write self and wait
        try {
            await set(ref(database, `queue/${this.myUid}`), {
                uid:        this.myUid,
                elo:        this.myElo,
                username:   this.myUsername,
                joinedAt:   serverTimestamp(),
                joinedAtMs: Date.now(),
                gameId:     null
            });
        } catch (err) {
            console.error("[multi] writing to queue FAILED:", err);
            this.onMessage("Firebase write error — check DB rules.");
            return;
        }

        // Remove queue entry automatically if this client disconnects
        onDisconnect(ref(database, `queue/${this.myUid}`)).remove().catch(() => {});

        this.onMessage("Waiting for opponent…");
        this._waitForGame();
    }

    // ----------------------------------------------------------
    // _createGame — host
    // ----------------------------------------------------------
    async _createGame(myAccount, opponent) {
        console.log("[multi] _createGame host:", myAccount.uid);

        const [startWord, endWord] = pickStartEnd();

        const gameRef = push(ref(database, "games"));
        this.gameId   = gameRef.key;

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
        } catch (err) {
            console.error("[multi] writing game doc FAILED:", err);
            this.onMessage("Firebase write error — check DB rules.");
            return;
        }

        // If host disconnects, mark game as abandoned with opponent as winner
        this._disconnectRef = ref(database, `games/${this.gameId}`);
        onDisconnect(this._disconnectRef).update({
            status: 'abandoned',
            winner: this.opponentUid,
        }).catch(() => {});

        // Signal the guest by writing gameId into their queue slot (retry up to 3x)
        {
            const guestNotif = {
                uid:      opponent.uid,
                elo:      this.opponentElo,
                username: opponentUsername,
                gameId:   this.gameId
            };
            let notified = false;
            for (let i = 0; i < 3; i++) {
                try {
                    await set(ref(database, `queue/${opponent.uid}`), guestNotif);
                    notified = true;
                    break;
                } catch (err) {
                    console.error(`[multi] notifying guest attempt ${i + 1} FAILED:`, err);
                    if (i < 2) await new Promise(r => setTimeout(r, 500 * (i + 1)));
                }
            }
            if (!notified) {
                console.error("[multi] could not notify guest after 3 attempts");
            }
        }

        this._initLocalBoard(startWord, endWord, opponentUsername);
        this._listenToGame();
    }

    // ----------------------------------------------------------
    // _waitForGame — guest watches their own queue slot
    // ----------------------------------------------------------
    _waitForGame() {
        const myQueueRef = ref(database, `queue/${this.myUid}`);
        let _hosting = false; // guard: once we start hosting, ignore further queue events

        // Primary: wait for a host to assign us a gameId
        this._unsubQueue = onValue(myQueueRef, async (snap) => {
            if (!snap.exists() || _hosting) return;
            const data = snap.val();
            if (!data.gameId) return;

            const gameId = data.gameId;
            this.gameId  = gameId;

            if (this._unsubQueue)      { this._unsubQueue();      this._unsubQueue      = null; }
            if (this._unsubQueueScan)  { this._unsubQueueScan();  this._unsubQueueScan  = null; }
            try { await remove(myQueueRef); } catch (_) {}

            // Load the full game document
            let gameSnap;
            try {
                gameSnap = await get(ref(database, `games/${gameId}`));
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
                }
            }

            if (!this.opponentUid) {
                console.error("[multi] could not find opponent UID in game doc");
                return;
            }

            // If guest disconnects, mark game abandoned with host as winner
            this._disconnectRef = ref(database, `games/${this.gameId}`);
            onDisconnect(this._disconnectRef).update({
                status: 'abandoned',
                winner: this.opponentUid,
            }).catch(() => {});

            this._initLocalBoard(game.startWord, game.endWord, this.opponentUsername);
            this._listenToGame();
        });

        // Secondary: scan the whole queue so we can claim a waiting peer and
        // become the host — handles the race where both players arrived at the
        // same time and both entered the waiting state before either could match.
        //
        // Tiebreaker: only claim opponents with a LARGER UID.
        // This guarantees that if A and B arrive simultaneously, only the one
        // with the smaller UID can ever claim the other — preventing both from
        // simultaneously claiming each other and creating two games.
        let _scanning = false;
        this._unsubQueueScan = onValue(ref(database, "queue"), async (snap) => {
            if (!snap.exists() || _hosting || _scanning) return;
            _scanning = true;
            try {
                const entries = snap.val();
                const now = Date.now();

                let bestKey = null, bestEntry = null, bestDiff = Infinity;
                for (const [key, entry] of Object.entries(entries)) {
                    if (entry.uid === this.myUid) continue;
                    if (entry.gameId) continue; // already matched
                    if (entry.uid < this.myUid) continue; // tiebreaker: defer to smaller UID
                    if (entry.joinedAtMs && (now - entry.joinedAtMs) > QUEUE_STALE_MS) continue;
                    const diff = Math.abs((entry.elo ?? 1000) - this.myElo);
                    if (diff < bestDiff) { bestDiff = diff; bestKey = key; bestEntry = entry; }
                }

                if (!bestKey) return;

                // Try to atomically claim the slot
                let committed = false;
                try {
                    const result = await runTransaction(ref(database, `queue/${bestKey}`), (current) => {
                        if (!current || current.gameId) return; // abort — taken
                        return null; // claim by deleting
                    });
                    committed = result.committed;
                } catch (_) {}

                if (!committed) return;

                _hosting = true;
                if (this._unsubQueue)     { this._unsubQueue();     this._unsubQueue     = null; }
                if (this._unsubQueueScan) { this._unsubQueueScan(); this._unsubQueueScan = null; }

                // Remove ourselves from the queue before creating the game
                try { await remove(myQueueRef); } catch (_) {}

                console.log("[multi] waitForGame: claimed waiting peer, becoming host");
                await this._createGame(this._myAccount, bestEntry);
            } finally {
                _scanning = false;
            }
        });
    }

    // ----------------------------------------------------------
    // _initLocalBoard
    // ----------------------------------------------------------
    _initLocalBoard(startWord, endWord, opponentName) {
        this.gameSession.initWords(startWord, endWord);
        this.onMatchFound({ gameId: this.gameId, startWord, endWord, opponentName });
    }

    // ----------------------------------------------------------
    // _listenToGame
    // ----------------------------------------------------------
    _listenToGame() {
        const seenOpponentWords = new Set();

        this._unsubGame = onValue(ref(database, `games/${this.gameId}`), async (snap) => {
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
                    this.onOpponentWord(word);
                }
            }

            // Abandon detection (opponent closed tab / lost connection)
            if (game.status === 'abandoned' && !this._gameOverFired) {
                this._gameOverFired = true;
                const iWon = game.winner === this.myUid;
                this.finished = true;
                this._cancelDisconnect();
                this.onGameOver({ won: iWon, opponentElo: this.opponentElo, myElo: this.myElo, abandoned: true });
                return;
            }

            // Game-over detection — _gameOverFired ensures this fires exactly once per game
            if (game.status === "finished" && !this._gameOverFired) {
                this._gameOverFired = true;
                const iWon = game.winner === this.myUid;
                console.log("[multi] game over, won:", iWon);
                if (!this.finished) {
                    this.finished = true;
                    this._cancelDisconnect();
                }
                // Fire for both winner and loser — winner is now determined by Firebase
                this.onGameOver({ won: iWon, opponentElo: this.opponentElo, myElo: this.myElo });
            }

            // Hint detection — both players requested a hint
            if (!this._hintDelivered && !this.finished) {
                const h = game.hint ?? {};
                if (h[this.myUid] && h[this.opponentUid]) {
                    if (!this._hintGranted) {
                        this._hintGranted = true;
                        if (this.myUid < this.opponentUid) {
                            // Host: compute and write hint word (guest picks it up on next event)
                            this._computeAndWriteHint(game);
                        }
                    }
                    // Deliver once hintWord is present (works for both host and guest)
                    if (game.hintWord) {
                        this._hintDelivered = true;
                        this.onHintGranted?.(game.hintWord.word, game.hintWord.connectedTo);
                    }
                }
            }

            // Skip-pair detection — both players requested a skip
            if (!this._skipGranted && !this.finished) {
                const sp = game.skipPair ?? {};
                if (sp[this.myUid] && sp[this.opponentUid]) {
                    this._skipGranted = true;
                    this.onSkipGranted?.();
                    this._startRematch();
                }
            }

            // Rematch detection — keep listening after game ends
            if (game.status === "finished" || game.status === "abandoned") {
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
    // _computeAndWriteHint  (host only)
    // ----------------------------------------------------------
    _computeAndWriteHint(game) {
        const engine = this.gameSession.engine;
        const state  = this.gameSession.boardState;
        if (!engine || !state) return;

        const { startWord, endWord } = game;

        // Find endpoints with no connections yet
        const isolated = [startWord, endWord].filter(w => {
            const idx = state.words.indexOf(w);
            return idx >= 0 && !state.edges.some(([i, j]) => i === idx || j === idx);
        });

        const target = isolated[0] ?? startWord;
        const { pairVocabLimit } = getConfig();
        // Iterate from most-common to least-common valid word; first match wins
        const allWords = engine.wordList(pairVocabLimit);
        let hint = null;
        for (let i = 0; i < allWords.length; i++) {
            const w = allWords[i];
            if (!isValidPairWord(i)) continue;
            if (state.words.includes(w)) continue;
            if (engine.pairSimilarity(w, target)?.isTrivial) { hint = w; break; }
        }

        if (hint) {
            set(ref(database, `games/${this.gameId}/hintWord`),
                { word: hint, connectedTo: target }).catch(() => {});
        }
    }

    // ----------------------------------------------------------
    // _cancelDisconnect — cancel pending onDisconnect handler
    // ----------------------------------------------------------
    _cancelDisconnect() {
        if (this._disconnectRef) {
            onDisconnect(this._disconnectRef).cancel().catch(() => {});
            this._disconnectRef = null;
        }
    }

    // ----------------------------------------------------------
    // submitWord
    // ----------------------------------------------------------
    async submitWord(rawInput) {
        if (this.finished) return { error: "Game is already over." };

        const result = this.gameSession.submitWord(rawInput);
        if (result.error) return result;

        {
            const wordsRef = ref(database,
                `games/${this.gameId}/players/${this.myUid}/words`);
            let pushed = false;
            for (let i = 0; i < 3; i++) {
                try {
                    await push(wordsRef, result.added);
                    pushed = true;
                    break;
                } catch {
                    if (i < 2) await new Promise(r => setTimeout(r, 400 * (i + 1)));
                }
            }
            if (!pushed) console.error("[multi] word push failed after 3 attempts — opponent won't see this word");
        }

        if (result.won) {
            this.finished = true;
            this._cancelDisconnect();
            // Use a transaction with timestamp so the first finisher wins if both complete simultaneously
            const nowMs = Date.now();
            let isConfirmedWinner = false;
            for (let i = 0; i < 3; i++) {
                try {
                    const txResult = await runTransaction(
                        ref(database, `games/${this.gameId}`),
                        (current) => {
                            if (!current) return current;
                            if (current.status === 'finished') {
                                // Keep whichever player finished earlier by client timestamp
                                if (typeof current.finishedAtMs === 'number' && current.finishedAtMs <= nowMs) {
                                    return; // abort — opponent was earlier
                                }
                            }
                            return { ...current, status: 'finished', winner: this.myUid, finishedAtMs: nowMs };
                        }
                    );
                    isConfirmedWinner = txResult.snapshot?.val()?.winner === this.myUid;
                    break;
                } catch {
                    if (i < 2) await new Promise(r => setTimeout(r, 500 * (i + 1)));
                }
            }
            if (isConfirmedWinner) {
                const winPath = this.gameSession.engine
                    ? this.gameSession.engine.shortestPath(this.gameSession.boardState)
                    : null;
                await saveGameResult(
                    this.myUid, true,
                    this.gameSession.wordsAdded,
                    this.gameSession.getElapsed(),
                    this.opponentElo,
                    "multiplayer",
                    {
                        startWord:        this.gameSession.startWord        ?? "",
                        endWord:          this.gameSession.endWord          ?? "",
                        totalGraphWords:  this.gameSession.graph ? this.gameSession.graph.wordCount : this.gameSession.wordsAdded,
                        wordsList:        [...(this.gameSession.wordsList ?? [])],
                        opponentUid:      this.opponentUid      ?? "",
                        opponentUsername: this.opponentUsername ?? "",
                        actualPath:       winPath ?? [],
                        bestPathLength:   winPath ? winPath.length : 0,
                    }
                );
            }
            // onGameOver fires via _listenToGame for both players
        }

        return result;
    }

    // ----------------------------------------------------------
    // requestRematch
    // ----------------------------------------------------------
    async requestRematch() {
        if (!this.gameId) return;
        try {
            await set(ref(database, `games/${this.gameId}/rematch/${this.myUid}`), true);
        } catch (err) {
            console.error("[multi] requestRematch FAILED:", err);
        }
    }

    // ----------------------------------------------------------
    // requestHint
    // ----------------------------------------------------------
    async requestHint() {
        if (!this.gameId || this._hintGranted) return;
        try {
            await set(ref(database, `games/${this.gameId}/hint/${this.myUid}`), true);
        } catch (err) {
            console.error("[multi] requestHint FAILED:", err);
        }
    }

    // ----------------------------------------------------------
    // requestSkipPair
    // ----------------------------------------------------------
    async requestSkipPair() {
        if (!this.gameId || this._skipGranted) return;
        try {
            await set(ref(database, `games/${this.gameId}/skipPair/${this.myUid}`), true);
        } catch (err) {
            console.error("[multi] requestSkipPair FAILED:", err);
        }
    }

    // ----------------------------------------------------------
    // _startRematch
    // ----------------------------------------------------------
    async _startRematch() {
        const oldGameId = this.gameId;
        console.log("[multi] _startRematch from game:", oldGameId);

        // Refresh both ELOs so rematch rating calculations use current values
        try {
            const [mySnap, oppSnap] = await Promise.all([
                get(ref(database, `users/${this.myUid}/elo`)),
                get(ref(database, `users/${this.opponentUid}/elo`))
            ]);
            if (mySnap.exists())  this.myElo      = mySnap.val();
            if (oppSnap.exists()) this.opponentElo = oppSnap.val();
        } catch (_) {}

        // Unsubscribe from old game listener first
        if (this._unsubGame)    { this._unsubGame();    this._unsubGame    = null; }
        if (this._unsubRematch) { this._unsubRematch(); this._unsubRematch = null; }

        // Reset state for the new game
        this._gameOverFired   = false;
        this._rematchStarted  = false;
        this._rematchNotified = false;
        this._hintGranted     = false;
        this._hintDelivered   = false;
        this._skipGranted     = false;
        this.finished         = false;


        const isHost = this.myUid < this.opponentUid;

        if (isHost) {
            const [sw, ew] = pickStartEnd();
            const gameRef  = push(ref(database, "games"));
            this.gameId    = gameRef.key;

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

                // Re-register disconnect handler for new game
                this._disconnectRef = ref(database, `games/${this.gameId}`);
                onDisconnect(this._disconnectRef).update({
                    status: 'abandoned',
                    winner: this.opponentUid,
                }).catch(() => {});

                // Write new game ID to old game doc so guest can find it
                await update(ref(database, `games/${oldGameId}`), { rematchGameId: this.gameId });
            } catch (err) {
                console.error("[multi] rematch game creation FAILED:", err);
                return;
            }

            this._initLocalBoard(sw, ew, this.opponentUsername);
            this._listenToGame();

        } else {
            // Guest: watch old game doc for rematchGameId written by host
            this._unsubRematch = onValue(ref(database, `games/${oldGameId}/rematchGameId`), async (snap) => {
                if (!snap.exists()) return;
                if (this._unsubRematch) { this._unsubRematch(); this._unsubRematch = null; }

                this.gameId = snap.val();

                try {
                    const gs = await get(ref(database, `games/${this.gameId}`));
                    if (!gs.exists()) {
                        console.error("[multi] rematch game doc not found");
                        return;
                    }
                    const g = gs.val();

                    // Re-register disconnect handler for new game
                    this._disconnectRef = ref(database, `games/${this.gameId}`);
                    onDisconnect(this._disconnectRef).update({
                        status: 'abandoned',
                        winner: this.opponentUid,
                    }).catch(() => {});

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
        if (this._unsubQueue)     { this._unsubQueue();     this._unsubQueue     = null; }
        if (this._unsubQueueScan) { this._unsubQueueScan(); this._unsubQueueScan = null; }
        try { await remove(ref(database, `queue/${this.myUid}`)); } catch (_) {}
    }

    cleanup() {
        if (this._unsubGame)      { this._unsubGame();      this._unsubGame      = null; }
        if (this._unsubQueue)     { this._unsubQueue();     this._unsubQueue     = null; }
        if (this._unsubQueueScan) { this._unsubQueueScan(); this._unsubQueueScan = null; }
        if (this._unsubRematch)   { this._unsubRematch();   this._unsubRematch   = null; }
        this._cancelDisconnect();
    }
}
