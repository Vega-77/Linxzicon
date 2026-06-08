// ============================================================\
// account.js — updated version
// Every Firebase read/write logs what it's doing and what
// it gets back, so we can see exactly where stats break.
// Includes tracking for rich analytics parameters.
// ============================================================\

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
        this.multiBestStreak  = d.multiBestStreak  ?? 0;
        this.multiCurStreak   = d.multiCurStreak   ?? 0;

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
            dailyLastDate:   this.dailyLastDate
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

/**
 * Enhanced saveGameResult to accept additional telemetry for deep stats dashboard
 */
export async function saveGameResult(uid, won, wordsUsed, solveTime, opponentElo, mode = "multiplayer", extraData = {}) {
    console.log(`[account] saveGameResult internal trigger: uid=${uid}, mode=${mode}, won=${won}, words=${wordsUsed}, time=${solveTime}s`);
    
    const account = await loadAccount(uid);
    if (!account) {
        console.error("[account] saveGameResult failed — could not load player profile");
        return null;
    }

    if (mode === "solo") {
        account.soloPlayed++;
        if (won) {
            account.soloWon++;
            const w = account.soloWon;
            account.soloAvgWords = ((account.soloAvgWords * (w - 1)) + wordsUsed) / w;
            account.soloAvgTime  = ((account.soloAvgTime  * (w - 1)) + solveTime)  / w;
            if (account.soloBestTime === 0 || solveTime < account.soloBestTime) {
                account.soloBestTime = solveTime;
            }
        }
    } else {
        // multiplayer
        account.multiPlayed++;
        if (won) {
            account.multiWon++;
            account.multiCurStreak++;
            if (account.multiCurStreak > account.multiBestStreak) {
                account.multiBestStreak = account.multiCurStreak;
            }
            const w = account.multiWon;
            account.multiAvgWords = ((account.multiAvgWords * (w - 1)) + wordsUsed) / w;
            account.multiAvgTime  = ((account.multiAvgTime  * (w - 1)) + solveTime)  / w;
        } else {
            account.multiLost++;
            account.multiCurStreak = 0;
        }

        if (opponentElo !== null && opponentElo !== undefined) {
            const oldElo = account.elo;
            account.elo = calcElo(oldElo, opponentElo, won);
            console.log(`[account] Elo updated from ${oldElo} to ${account.elo} against opponent (${opponentElo})`);
        }
    }

    try {
        await update(ref(database, `users/${uid}`), account.toObject());
        console.log("[account] profile totals updated successfully");
    } catch (err) {
        console.error("[account] profile totals update failed:", err);
    }

    // Push enhanced match history block
    const historyEntry = {
        date:             new Date().toISOString(),
        mode,
        won,
        wordsUsed,
        solveTime,
        eloAtTime:        account.elo,
        startWord:        extraData.startWord ?? "",
        endWord:          extraData.endWord ?? "",
        totalGraphWords:  extraData.totalGraphWords ?? wordsUsed,
        bestPathLength:   extraData.bestPathLength ?? 0,
        actualPath:       extraData.actualPath ?? [],
        wordsList:        extraData.wordsList ?? [],
        opponentUid:      extraData.opponentUid ?? "",
        opponentUsername: extraData.opponentUsername ?? ""
    };

    try {
        await push(ref(database, `users/${uid}/history`), historyEntry);
        console.log("[account] rich match history entry appended");
    } catch (err) {
        console.error("[account] match history append failed:", err);
    }

    return account;
}

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