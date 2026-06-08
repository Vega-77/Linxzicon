// ============================================================
// account.js
// Firebase account read/write with rich analytics tracking.
// ============================================================

import { database, auth }              from "./firebase-config.js";
import { ref, set, get, update, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const DEFAULT_ELO = 1000;

export class Account {
    constructor(data) {
        const d = data ?? {};
        this.uid      = d.uid;
        this.username = d.username;
        this.email    = d.email;
        this.elo      = d.elo ?? DEFAULT_ELO;

        this.soloPlayed   = d.soloPlayed   ?? 0;
        this.soloWon      = d.soloWon      ?? 0;
        this.soloAvgWords = d.soloAvgWords ?? 0;
        this.soloAvgTime  = d.soloAvgTime  ?? 0;
        this.soloBestTime = d.soloBestTime ?? 0;

        this.multiPlayed      = d.multiPlayed      ?? 0;
        this.multiWon         = d.multiWon         ?? 0;
        this.multiLost        = d.multiLost        ?? 0;
        this.multiAvgWords    = d.multiAvgWords    ?? 0;
        this.multiAvgTime     = d.multiAvgTime     ?? 0;
        // Support both old field names (winStreak/currentStreak) and new ones
        this.multiBestStreak  = d.multiBestStreak  ?? d.winStreak     ?? 0;
        this.multiCurStreak   = d.multiCurStreak   ?? d.currentStreak ?? 0;

        // Daily Mode
        this.dailyPlayed     = d.dailyPlayed     ?? 0;
        this.dailyAvgWords   = d.dailyAvgWords   ?? 0;
        this.dailyAvgPath    = d.dailyAvgPath    ?? 0;
        this.dailyStreak     = d.dailyStreak     ?? 0;
        this.dailyBestStreak = d.dailyBestStreak ?? 0;
        this.dailyLastDate   = d.dailyLastDate   ?? "";
    }

    toObject() {
        return {
            uid:             this.uid,
            username:        this.username,
            email:           this.email,
            elo:             this.elo,
            soloPlayed:      this.soloPlayed,
            soloWon:         this.soloWon,
            soloAvgWords:    this.soloAvgWords,
            soloAvgTime:     this.soloAvgTime,
            soloBestTime:    this.soloBestTime,
            multiPlayed:     this.multiPlayed,
            multiWon:        this.multiWon,
            multiLost:       this.multiLost,
            multiAvgWords:   this.multiAvgWords,
            multiAvgTime:    this.multiAvgTime,
            multiBestStreak: this.multiBestStreak,
            multiCurStreak:  this.multiCurStreak,
            dailyPlayed:     this.dailyPlayed,
            dailyAvgWords:   this.dailyAvgWords,
            dailyAvgPath:    this.dailyAvgPath,
            dailyStreak:     this.dailyStreak,
            dailyBestStreak: this.dailyBestStreak,
            dailyLastDate:   this.dailyLastDate,
        };
    }
}

export async function createAccount(uid, username, email) {
    console.log(`[account] createAccount calling for ${uid} (${username})`);
    const a = new Account({ uid, username, email });
    try {
        await set(ref(database, `users/${uid}`), a.toObject());
        console.log("[account] createAccount write SUCCESS");
        return a;
    } catch (err) {
        console.error("[account] createAccount write FAILED:", err);
        throw err;
    }
}

export async function loadAccount(uid) {
    if (!uid) {
        console.warn("[account] loadAccount called with empty uid");
        return null;
    }
    console.log(`[account] loadAccount fetching /users/${uid}`);
    try {
        const snap = await get(ref(database, `users/${uid}`));
        if (!snap.exists()) {
            // Profile missing — registration was interrupted before the DB write completed.
            const user = auth.currentUser;
            if (user) {
                console.warn("[account] loadAccount: no profile found, creating default");
                const account = new Account({
                    uid,
                    username: user.displayName ?? user.email.split("@")[0],
                    email:    user.email,
                });
                await set(ref(database, `users/${uid}`), account.toObject());
                return account;
            }
            console.warn(`[account] loadAccount node /users/${uid} does not exist`);
            return null;
        }
        const a = new Account(snap.val());
        console.log("[account] loadAccount parsed account for:", a.username, "Elo:", a.elo);
        return a;
    } catch (err) {
        console.error("[account] loadAccount fetch FAILED:", err);
        return null;
    }
}

// ============================================================
// saveGameResult
// opponentElo === null  → solo game
// opponentElo === number → multiplayer game
// mode: "solo" | "multiplayer" (inferred from opponentElo if omitted)
// extraData: optional rich telemetry for the analytics dashboard
// ============================================================
export async function saveGameResult(uid, won, wordsUsed, solveTime, opponentElo = null, mode = null, extraData = {}) {
    const isSolo = opponentElo === null || mode === "solo";
    const effectiveMode = mode ?? (isSolo ? "solo" : "multiplayer");

    console.log(`[account] saveGameResult uid=${uid} mode=${effectiveMode} won=${won} words=${wordsUsed} time=${solveTime}s`);

    const account = await loadAccount(uid);
    if (!account) {
        console.error("[account] saveGameResult failed — could not load player profile");
        return null;
    }

    if (isSolo) {
        account.soloPlayed++;
        if (won) {
            account.soloWon++;
            const w = account.soloWon;
            if (wordsUsed > 0)
                account.soloAvgWords = ((account.soloAvgWords * (w - 1)) + wordsUsed) / w;
            if (solveTime > 0)
                account.soloAvgTime  = ((account.soloAvgTime  * (w - 1)) + solveTime)  / w;
            if (account.soloBestTime === 0 || solveTime < account.soloBestTime)
                account.soloBestTime = solveTime;
        }
    } else {
        account.multiPlayed++;
        if (won) {
            account.multiWon++;
            account.multiCurStreak++;
            if (account.multiCurStreak > account.multiBestStreak)
                account.multiBestStreak = account.multiCurStreak;
            const w = account.multiWon;
            if (wordsUsed > 0)
                account.multiAvgWords = ((account.multiAvgWords * (w - 1)) + wordsUsed) / w;
            if (solveTime > 0)
                account.multiAvgTime  = ((account.multiAvgTime  * (w - 1)) + solveTime)  / w;
        } else {
            account.multiLost++;
            account.multiCurStreak = 0;
        }

        if (opponentElo !== null && opponentElo !== undefined) {
            const oldElo = account.elo;
            account.elo = calcElo(oldElo, opponentElo, won);
            console.log(`[account] Elo ${oldElo} → ${account.elo}`);
        }
    }

    try {
        await update(ref(database, `users/${uid}`), account.toObject());
        console.log("[account] profile totals updated");
    } catch (err) {
        console.error("[account] profile totals update failed:", err);
    }

    // Rich history entry for the analytics dashboard
    const historyEntry = {
        date:             new Date().toISOString(),
        mode:             effectiveMode,
        won,
        wordsUsed,
        solveTime,
        eloAtTime:        account.elo,
        startWord:        extraData.startWord        ?? "",
        endWord:          extraData.endWord          ?? "",
        totalGraphWords:  extraData.totalGraphWords  ?? wordsUsed,
        bestPathLength:   extraData.bestPathLength   ?? 0,
        actualPath:       extraData.actualPath       ?? [],
        wordsList:        extraData.wordsList        ?? [],
        opponentUid:      extraData.opponentUid      ?? "",
        opponentUsername: extraData.opponentUsername ?? "",
    };

    try {
        await push(ref(database, `users/${uid}/history`), historyEntry);
        console.log("[account] rich history entry appended");
    } catch (err) {
        console.error("[account] history append failed:", err);
    }

    return account;
}

// ============================================================
// saveDailyStats
// Called once when user completes today's puzzle.
// ============================================================
export async function saveDailyStats(uid, wordsUsed, pathLength) {
    const account = await loadAccount(uid);
    if (!account) return;

    const today = new Date().toISOString().slice(0, 10);
    const prev  = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    if (account.dailyLastDate === today) return; // guard: already counted today

    account.dailyPlayed++;
    account.dailyAvgWords = ((account.dailyAvgWords * (account.dailyPlayed - 1)) + wordsUsed) / account.dailyPlayed;
    account.dailyAvgPath  = ((account.dailyAvgPath  * (account.dailyPlayed - 1)) + pathLength) / account.dailyPlayed;
    account.dailyStreak   = account.dailyLastDate === prev ? account.dailyStreak + 1 : 1;
    if (account.dailyStreak > account.dailyBestStreak) account.dailyBestStreak = account.dailyStreak;
    account.dailyLastDate = today;

    try {
        await update(ref(database, `users/${uid}`), account.toObject());
    } catch (err) {
        console.error("[account] saveDailyStats write FAILED:", err);
    }
}

export function calcElo(playerElo, opponentElo, won) {
    const K = 32;
    const expected = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
    const actual   = won ? 1 : 0;
    return Math.round(playerElo + K * (actual - expected));
}

export function calcEloDelta(playerElo, opponentElo, won) {
    return calcElo(playerElo, opponentElo, won) - playerElo;
}
