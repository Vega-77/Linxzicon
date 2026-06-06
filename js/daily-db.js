import { database }  from "./firebase-config.js";
import {
    ref, get, set,
    runTransaction,
    query, orderByKey, limitToLast
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import { pickStartEnd } from "./game.js";

// ── Helpers ──────────────────────────────────────────────────
export function todayStr() {
    return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ── Daily pair ───────────────────────────────────────────────
// Uses a transaction so only one pair is ever written per day,
// even if two players open the app simultaneously at midnight.
export async function getDailyPair(dateStr) {
    const pairRef = ref(database, `daily/${dateStr}`);
    const result  = await runTransaction(pairRef, (current) => {
        if (current?.startWord) return undefined; // exists — abort write
        const [sw, ew] = pickStartEnd();
        return { startWord: sw, endWord: ew };
    });
    const data = result.snapshot.val();
    return { startWord: data.startWord, endWord: data.endWord };
}

// ── Leaderboard entries ──────────────────────────────────────
export async function saveDailyEntry(dateStr, uid, entry) {
    await set(ref(database, `daily/${dateStr}/entries/${uid}`), entry);
}

export async function getDailyEntry(dateStr, uid) {
    const snap = await get(ref(database, `daily/${dateStr}/entries/${uid}`));
    return snap.exists() ? snap.val() : null;
}

export async function getDailyLeaderboard(dateStr) {
    const snap = await get(ref(database, `daily/${dateStr}/entries`));
    return snap.exists() ? Object.values(snap.val()) : [];
}

// ── Archive ──────────────────────────────────────────────────
// Returns the last `limitDays` calendar days that have a stored
// daily pair, newest first. Each element: { date, startWord, endWord }.
export async function getArchiveData(limitDays = 30) {
    const snap = await get(query(
        ref(database, "daily"),
        orderByKey(),
        limitToLast(limitDays + 1)
    ));
    if (!snap.exists()) return [];
    return Object.entries(snap.val())
        .map(([date, val]) => ({
            date,
            startWord: val.startWord ?? "?",
            endWord:   val.endWord   ?? "?"
        }))
        .sort((a, b) => b.date.localeCompare(a.date)); // newest first
}
