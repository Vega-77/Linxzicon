// ============================================================
// stats.js
// Populates stats.html with the player's profile data and
// match history from Firebase.
//
// loadStats() is called from stats.html after requireAuth()
// has already resolved, so we receive uid and account as
// parameters rather than re-fetching them here.
// ============================================================

import { database } from "./firebase-config.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ============================================================
// loadStats
// Main entry point called from stats.html.
//   uid     — Firebase UID of the logged-in user
//   account — Account instance already loaded by the page
// ============================================================
export async function loadStats(uid, account) {
    if (!account) {
        document.getElementById("stats-container").textContent =
            "Could not load stats.";
        return;
    }

    renderSummary(account);
    await renderHistory(uid);
}

// ============================================================
// renderSummary
// Fills the eight stat-card values at the top of the page.
// ============================================================
function renderSummary(account) {
    // Convenience: set an element's text by its id
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    setText("stat-username",   account.username);
    setText("stat-elo",        account.elo);
    setText("stat-played",     account.gamesPlayed);
    setText("stat-won",        account.gamesWon);
    setText("stat-lost",       account.gamesLost);
    setText("stat-winrate",    account.winRate);
    setText("stat-avg-words",  account.gamesWon > 0
                                   ? account.avgWordsUsed.toFixed(1)
                                   : "—");
    setText("stat-avg-time",   account.gamesWon > 0
                                   ? formatTime(account.avgSolveTime)
                                   : "—");
    setText("stat-streak",     account.winStreak);
    setText("stat-cur-streak", account.currentStreak);
}

// ============================================================
// renderHistory
// Fetches /users/{uid}/history, sorts newest-first,
// and builds the match history table.
// Shows the most recent 20 games.
// ============================================================
async function renderHistory(uid) {
    const container = document.getElementById("history-container");
    if (!container) return;

    const snapshot = await get(ref(database, `users/${uid}/history`));

    if (!snapshot.exists()) {
        container.innerHTML = "<p class='no-history'>No games played yet.</p>";
        return;
    }

    // Firebase push IDs are chronological, so reversing gives newest-first
    const entries = Object.values(snapshot.val()).reverse().slice(0, 20);

    const table = document.createElement("table");
    table.className = "history-table";

    table.innerHTML = `
        <thead>
            <tr>
                <th>Date</th>
                <th>Result</th>
                <th>Words Used</th>
                <th>Solve Time</th>
                <th>Elo After</th>
            </tr>
        </thead>
    `;

    const tbody = document.createElement("tbody");

    for (const entry of entries) {
        const tr    = document.createElement("tr");
        tr.className = entry.won ? "row-win" : "row-loss";

        tr.innerHTML = `
            <td>${formatDate(entry.date)}</td>
            <td class="${entry.won ? "result-win" : "result-loss"}">
                ${entry.won ? "Win" : "Loss"}
            </td>
            <td>${entry.wordsUsed > 0 ? entry.wordsUsed : "—"}</td>
            <td>${entry.solveTime > 0 ? formatTime(entry.solveTime) : "—"}</td>
            <td>${entry.eloAtTime ?? "—"}</td>
        `;

        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);
}

// ============================================================
// formatTime
// Converts seconds to a readable string.
//   62  → "1m 2s"
//   45  → "45s"
// ============================================================
function formatTime(seconds) {
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ============================================================
// formatDate
// Converts an ISO date string to "Jun 1, 2026".
// ============================================================
function formatDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
        month: "short",
        day:   "numeric",
        year:  "numeric"
    });
}