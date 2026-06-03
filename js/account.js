// ============================================================
// account.js
// Account class and all Firebase read/write for user profiles.
//
// Stats are split into solo and multiplayer buckets so each
// mode has its own games played / won / lost / averages.
// Elo only changes in multiplayer games.
// ============================================================

import { database }                    from "./firebase-config.js";
import { ref, set, get, update, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const DEFAULT_ELO = 1000;

// ============================================================
// Account
// ============================================================
export class Account {
    constructor(data) {
        const d = data ?? {};
        this.uid      = d.uid;
        this.username = d.username;
        this.email    = d.email;
        this.elo      = d.elo ?? DEFAULT_ELO;

        // ── Solo stats ──
        this.soloPlayed   = d.soloPlayed   ?? 0;
        this.soloWon      = d.soloWon      ?? 0;
        this.soloAvgWords = d.soloAvgWords ?? 0;
        this.soloAvgTime  = d.soloAvgTime  ?? 0;
        this.soloBestTime = d.soloBestTime ?? 0; // fastest solo win in seconds

        // ── Multiplayer stats ──
        this.multiPlayed      = d.multiPlayed      ?? 0;
        this.multiWon         = d.multiWon         ?? 0;
        this.multiLost        = d.multiLost        ?? 0;
        this.multiAvgWords    = d.multiAvgWords    ?? 0;
        this.multiAvgTime     = d.multiAvgTime     ?? 0;
        this.winStreak        = d.winStreak        ?? 0;
        this.currentStreak    = d.currentStreak    ?? 0;
    }

    get soloWinRate() {
        if (this.soloPlayed === 0) return "0%";
        return ((this.soloWon / this.soloPlayed) * 100).toFixed(1) + "%";
    }

    get multiWinRate() {
        if (this.multiPlayed === 0) return "0%";
        return ((this.multiWon / this.multiPlayed) * 100).toFixed(1) + "%";
    }

    // Keep backward-compat helpers used by lobby.html
    get gamesPlayed() { return this.soloPlayed + this.multiPlayed; }
    get gamesWon()    { return this.soloWon    + this.multiWon; }
    get gamesLost()   { return this.multiLost; }
    get avgWordsUsed(){ return this.soloWon > 0 ? this.soloAvgWords : this.multiAvgWords; }
    get avgSolveTime(){ return this.soloWon > 0 ? this.soloAvgTime  : this.multiAvgTime;  }
    get winRate()     { return this.multiWinRate; }

    toObject() {
        return {
            uid:           this.uid,
            username:      this.username,
            email:         this.email,
            elo:           this.elo,
            soloPlayed:    this.soloPlayed,
            soloWon:       this.soloWon,
            soloAvgWords:  this.soloAvgWords,
            soloAvgTime:   this.soloAvgTime,
            soloBestTime:  this.soloBestTime,
            multiPlayed:   this.multiPlayed,
            multiWon:      this.multiWon,
            multiLost:     this.multiLost,
            multiAvgWords: this.multiAvgWords,
            multiAvgTime:  this.multiAvgTime,
            winStreak:     this.winStreak,
            currentStreak: this.currentStreak,
        };
    }
}

// ============================================================
// createAccount — called once on registration
// ============================================================
export async function createAccount(uid, username, email) {
    const account = new Account({ uid, username, email });
    await set(ref(database, `users/${uid}`), account.toObject());
    return account;
}

// ============================================================
// loadAccount
// ============================================================
export async function loadAccount(uid) {
    const snap = await get(ref(database, `users/${uid}`));
    if (!snap.exists()) return null;
    return new Account(snap.val());
}

// ============================================================
// saveGameResult
// isSolo: true for solo games, false for multiplayer
// ============================================================
export async function saveGameResult(uid, won, wordsUsed, solveTime, opponentElo = null) {
    // Determine mode from whether opponentElo was provided
    const isSolo = opponentElo === null;
    return isSolo
        ? _saveSoloResult(uid, won, wordsUsed, solveTime)
        : _saveMultiResult(uid, won, wordsUsed, solveTime, opponentElo);
}

async function _saveSoloResult(uid, won, wordsUsed, solveTime) {
    const account = await loadAccount(uid);
    if (!account) return;

    account.soloPlayed++;

    if (won) {
        account.soloWon++;
        const wins = account.soloWon;
        if (wordsUsed > 0)
            account.soloAvgWords = ((account.soloAvgWords * (wins - 1)) + wordsUsed) / wins;
        if (solveTime > 0)
            account.soloAvgTime  = ((account.soloAvgTime  * (wins - 1)) + solveTime)  / wins;
        if (account.soloBestTime === 0 || solveTime < account.soloBestTime)
            account.soloBestTime = solveTime;
    }

    await update(ref(database, `users/${uid}`), account.toObject());
    await push(ref(database, `users/${uid}/history`), {
        date:      new Date().toISOString(),
        mode:      "solo",
        won,
        wordsUsed,
        solveTime,
        eloAtTime: account.elo
    });

    return account;
}

async function _saveMultiResult(uid, won, wordsUsed, solveTime, opponentElo) {
    const account = await loadAccount(uid);
    if (!account) return;

    account.multiPlayed++;

    if (won) {
        account.multiWon++;
        account.currentStreak++;
        if (account.currentStreak > account.winStreak)
            account.winStreak = account.currentStreak;
        const wins = account.multiWon;
        if (wordsUsed > 0)
            account.multiAvgWords = ((account.multiAvgWords * (wins - 1)) + wordsUsed) / wins;
        if (solveTime > 0)
            account.multiAvgTime  = ((account.multiAvgTime  * (wins - 1)) + solveTime)  / wins;
    } else {
        account.multiLost++;
        account.currentStreak = 0;
    }

    account.elo = _calcElo(account.elo, opponentElo, won);

    await update(ref(database, `users/${uid}`), account.toObject());
    await push(ref(database, `users/${uid}/history`), {
        date:      new Date().toISOString(),
        mode:      "multiplayer",
        won,
        wordsUsed,
        solveTime,
        eloAtTime: account.elo
    });

    return account;
}

function _calcElo(playerElo, opponentElo, won) {
    const K        = 32;
    const expected = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
    return Math.round(playerElo + K * ((won ? 1 : 0) - expected));
}