// ============================================================
// account.js
// Defines the Account class and all Firebase read/write
// operations related to user profiles and statistics.
// ============================================================

import { database }                    from "./firebase-config.js";
import { ref, set, get, update, push } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// Default Elo rating assigned to every new player
const DEFAULT_ELO = 1000;

// ============================================================
// Account
// Mirrors what is stored in Firebase under /users/{uid}.
// All fields have safe defaults so a partial DB record
// never causes undefined errors.
// ============================================================
export class Account {
    constructor({
        uid, username, email,
        elo, gamesPlayed, gamesWon, gamesLost,
        avgWordsUsed, avgSolveTime, winStreak, currentStreak
    }) {
        this.uid           = uid;
        this.username      = username;
        this.email         = email;
        this.elo           = elo           ?? DEFAULT_ELO;
        this.gamesPlayed   = gamesPlayed   ?? 0;
        this.gamesWon      = gamesWon      ?? 0;
        this.gamesLost     = gamesLost     ?? 0;
        this.avgWordsUsed  = avgWordsUsed  ?? 0; // rolling avg words used per win
        this.avgSolveTime  = avgSolveTime  ?? 0; // rolling avg seconds per win
        this.winStreak     = winStreak     ?? 0; // all-time best win streak
        this.currentStreak = currentStreak ?? 0; // current active streak
    }

    // Win rate as a percentage string, e.g. "62.5%"
    get winRate() {
        if (this.gamesPlayed === 0) return "0%";
        return ((this.gamesWon / this.gamesPlayed) * 100).toFixed(1) + "%";
    }

    // Plain object for writing to Firebase
    toObject() {
        return {
            uid:           this.uid,
            username:      this.username,
            email:         this.email,
            elo:           this.elo,
            gamesPlayed:   this.gamesPlayed,
            gamesWon:      this.gamesWon,
            gamesLost:     this.gamesLost,
            avgWordsUsed:  this.avgWordsUsed,
            avgSolveTime:  this.avgSolveTime,
            winStreak:     this.winStreak,
            currentStreak: this.currentStreak
        };
    }
}

// ============================================================
// createAccount
// Writes a brand-new Account to /users/{uid}.
// Called once immediately after Firebase Auth registration.
// ============================================================
export async function createAccount(uid, username, email) {
    const account = new Account({ uid, username, email });
    await set(ref(database, `users/${uid}`), account.toObject());
    return account;
}

// ============================================================
// loadAccount
// Reads a user's account from /users/{uid}.
// Returns an Account instance, or null if not found.
// ============================================================
export async function loadAccount(uid) {
    const snapshot = await get(ref(database, `users/${uid}`));
    if (!snapshot.exists()) return null;
    return new Account(snapshot.val());
}

// ============================================================
// saveGameResult
// Called at the end of every game (win or loss).
// Updates counters, rolling averages, streak, and Elo.
//
//   uid         — Firebase UID of the player to update
//   won         — true if this player won
//   wordsUsed   — words the player added to the graph
//   solveTime   — seconds taken (0 if they lost)
//   opponentElo — opponent's Elo for multiplayer Elo calc;
//                 pass null for solo games (Elo unchanged)
// ============================================================
export async function saveGameResult(uid, won, wordsUsed, solveTime, opponentElo = null) {
    const account = await loadAccount(uid);
    if (!account) return;

    // ── Basic counters ──
    account.gamesPlayed++;

    if (won) {
        account.gamesWon++;
        account.currentStreak++;
        if (account.currentStreak > account.winStreak) {
            account.winStreak = account.currentStreak;
        }
    } else {
        account.gamesLost++;
        account.currentStreak = 0;
    }

    // ── Rolling averages (only updated on a win) ──
    // Formula: newAvg = ((oldAvg * (wins - 1)) + newValue) / wins
    // We read gamesWon AFTER incrementing above, so wins >= 1 here.
    if (won && wordsUsed > 0) {
        const wins = account.gamesWon;
        account.avgWordsUsed = ((account.avgWordsUsed * (wins - 1)) + wordsUsed) / wins;
        account.avgSolveTime = ((account.avgSolveTime * (wins - 1)) + solveTime)  / wins;
    }

    // ── Elo (multiplayer only) ──
    if (opponentElo !== null) {
        account.elo = calculateElo(account.elo, opponentElo, won);
    }

    // ── Write updated profile back ──
    await update(ref(database, `users/${uid}`), account.toObject());

    // ── Append match history entry ──
    await push(ref(database, `users/${uid}/history`), {
        date:      new Date().toISOString(),
        won,
        wordsUsed,
        solveTime,
        eloAtTime: account.elo
    });

    return account;
}

// ============================================================
// calculateElo
// Standard Elo formula with K=32.
// Returns the player's new integer Elo rating.
//
// expected = probability of winning given the rating gap
// actual   = 1 (win) or 0 (loss)
// ============================================================
function calculateElo(playerElo, opponentElo, won) {
    const K        = 32;
    const expected = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
    const actual   = won ? 1 : 0;
    return Math.round(playerElo + K * (actual - expected));
}