// ============================================================
// account.js — debug version
// Every Firebase read/write logs what it's doing and what
// it gets back, so we can see exactly where stats break.
// ============================================================

import { database }                    from "./firebase-config.js";
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
        this.winStreak        = d.winStreak        ?? 0;
        this.currentStreak    = d.currentStreak    ?? 0;
    }

    get soloWinRate()  {
        if (this.soloPlayed  === 0) return "0%";
        return ((this.soloWon  / this.soloPlayed)  * 100).toFixed(1) + "%";
    }
    get multiWinRate() {
        if (this.multiPlayed === 0) return "0%";
        return ((this.multiWon / this.multiPlayed) * 100).toFixed(1) + "%";
    }

    // Backward-compat for lobby.html
    get gamesPlayed() { return this.soloPlayed + this.multiPlayed; }
    get gamesWon()    { return this.soloWon    + this.multiWon; }
    get gamesLost()   { return this.multiLost; }
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
// createAccount
// ============================================================
export async function createAccount(uid, username, email) {
    console.log("[account] createAccount uid:", uid, "username:", username);
    const account = new Account({ uid, username, email });
    try {
        await set(ref(database, `users/${uid}`), account.toObject());
        console.log("[account] createAccount write OK");
    } catch (err) {
        console.error("[account] createAccount write FAILED:", err);
        throw err;
    }
    return account;
}

// ============================================================
// loadAccount
// ============================================================
export async function loadAccount(uid) {
    console.log("[account] loadAccount uid:", uid);
    try {
        const snap = await get(ref(database, `users/${uid}`));
        console.log("[account] loadAccount exists:", snap.exists(),
            "val:", snap.exists() ? JSON.stringify(snap.val()).slice(0, 120) : "null");
        if (!snap.exists()) return null;
        const account = new Account(snap.val());
        console.log("[account] loadAccount parsed OK, username:", account.username,
            "elo:", account.elo, "soloPlayed:", account.soloPlayed,
            "multiPlayed:", account.multiPlayed);
        return account;
    } catch (err) {
        console.error("[account] loadAccount FAILED:", err);
        throw err;
    }
}

// ============================================================
// saveGameResult
// opponentElo === null  → solo game
// opponentElo === number → multiplayer game
// ============================================================
export async function saveGameResult(uid, won, wordsUsed, solveTime, opponentElo = null) {
    const isSolo = opponentElo === null;
    console.log(`[account] saveGameResult uid:${uid} isSolo:${isSolo} won:${won} words:${wordsUsed} time:${solveTime} oppElo:${opponentElo}`);
    return isSolo
        ? _saveSoloResult(uid, won, wordsUsed, solveTime)
        : _saveMultiResult(uid, won, wordsUsed, solveTime, opponentElo);
}

async function _saveSoloResult(uid, won, wordsUsed, solveTime) {
    const account = await loadAccount(uid);
    if (!account) { console.error("[account] _saveSoloResult: no account found for uid", uid); return; }

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

    console.log("[account] _saveSoloResult writing:", JSON.stringify(account.toObject()).slice(0, 120));
    try {
        await update(ref(database, `users/${uid}`), account.toObject());
        console.log("[account] _saveSoloResult profile update OK");
        const histRef = ref(database, `users/${uid}/history`);
        await push(histRef, {
            date: new Date().toISOString(), mode: "solo",
            won, wordsUsed, solveTime, eloAtTime: account.elo
        });
        console.log("[account] _saveSoloResult history push OK");
    } catch (err) {
        console.error("[account] _saveSoloResult write FAILED:", err);
    }
    return account;
}

async function _saveMultiResult(uid, won, wordsUsed, solveTime, opponentElo) {
    const account = await loadAccount(uid);
    if (!account) { console.error("[account] _saveMultiResult: no account for uid", uid); return; }

    account.multiPlayed++;
    if (won) {
        account.multiWon++;
        account.currentStreak++;
        if (account.currentStreak > account.winStreak) account.winStreak = account.currentStreak;
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

    console.log("[account] _saveMultiResult writing:", JSON.stringify(account.toObject()).slice(0, 120));
    try {
        await update(ref(database, `users/${uid}`), account.toObject());
        console.log("[account] _saveMultiResult profile update OK");
        await push(ref(database, `users/${uid}/history`), {
            date: new Date().toISOString(), mode: "multiplayer",
            won, wordsUsed, solveTime, eloAtTime: account.elo
        });
        console.log("[account] _saveMultiResult history push OK");
    } catch (err) {
        console.error("[account] _saveMultiResult write FAILED:", err);
    }
    return account;
}

function _calcElo(playerElo, opponentElo, won) {
    const K = 32;
    const expected = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
    return Math.round(playerElo + K * ((won ? 1 : 0) - expected));
}