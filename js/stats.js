// ============================================================
// stats.js — fixed version
// Removed reference to non-existent "stats-container" ID.
// Added console logging so failures are visible.
// ============================================================

import { database } from "./firebase-config.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

export async function loadStats(uid, account) {
    console.log("[stats] loadStats uid:", uid, "account:", account?.username);

    if (!account) {
        console.error("[stats] no account provided to loadStats");
        // Show error inside the history container which always exists
        const c = document.getElementById("history-container");
        if (c) c.innerHTML = "<p class='no-history'>Could not load stats — not logged in?</p>";
        return;
    }

    renderSummary(account);
    await renderHistory(uid);
}

function renderSummary(account) {
    console.log("[stats] renderSummary, soloPlayed:", account.soloPlayed,
        "multiPlayed:", account.multiPlayed, "elo:", account.elo);

    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = val;
        } else {
            console.warn("[stats] element not found:", id);
        }
    };

    setText("stat-username",         account.username);
    setText("stat-elo",              account.elo);

    // Solo
    setText("stat-solo-played",      account.soloPlayed);
    setText("stat-solo-won",         account.soloWon);
    setText("stat-solo-avg-words",   account.soloWon > 0
                                         ? account.soloAvgWords.toFixed(1) : "—");
    setText("stat-solo-avg-time",    account.soloWon > 0
                                         ? fmtTime(account.soloAvgTime) : "—");
    setText("stat-solo-best-time",   account.soloBestTime > 0
                                         ? fmtTime(account.soloBestTime) : "—");

    // Multiplayer
    setText("stat-multi-played",     account.multiPlayed);
    setText("stat-multi-won",        account.multiWon);
    setText("stat-multi-lost",       account.multiLost);
    setText("stat-multi-winrate",    account.multiWinRate);
    setText("stat-multi-avg-words",  account.multiWon > 0
                                         ? account.multiAvgWords.toFixed(1) : "—");
    setText("stat-multi-avg-time",   account.multiWon > 0
                                         ? fmtTime(account.multiAvgTime) : "—");
    setText("stat-multi-streak",     account.winStreak);
    setText("stat-multi-cur-streak", account.currentStreak);
}

async function renderHistory(uid) {
    const container = document.getElementById("history-container");
    if (!container) { console.error("[stats] #history-container not found"); return; }

    console.log("[stats] loading history for uid:", uid);

    let snap;
    try {
        snap = await get(ref(database, `users/${uid}/history`));
        console.log("[stats] history exists:", snap.exists(),
            "count:", snap.exists() ? Object.keys(snap.val()).length : 0);
    } catch (err) {
        console.error("[stats] loading history FAILED:", err);
        container.innerHTML = "<p class='no-history'>Failed to load history — check Firebase rules.</p>";
        return;
    }

    if (!snap.exists()) {
        container.innerHTML = "<p class='no-history'>No games played yet.</p>";
        return;
    }

    // Firebase returns push-key objects; sort by date descending
    const entries = Object.values(snap.val())
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 20);

    const table = document.createElement("table");
    table.className = "history-table";
    table.innerHTML = `
        <thead>
            <tr>
                <th>Date</th>
                <th>Mode</th>
                <th>Result</th>
                <th>Words</th>
                <th>Time</th>
                <th>Elo After</th>
            </tr>
        </thead>`;

    const tbody = document.createElement("tbody");

    for (const e of entries) {
        const tr = document.createElement("tr");
        tr.className = e.won ? "row-win" : "row-loss";
        const modeName  = e.mode === "multiplayer" ? "Multi" : "Solo";
        const modeClass = e.mode === "multiplayer" ? "mode-multiplayer" : "mode-solo";
        tr.innerHTML = `
            <td>${fmtDate(e.date)}</td>
            <td><span class="mode-badge ${modeClass}">${modeName}</span></td>
            <td class="${e.won ? "result-win" : "result-loss"}">${e.won ? "Win ✓" : "Loss"}</td>
            <td>${e.wordsUsed > 0 ? e.wordsUsed : "—"}</td>
            <td>${e.solveTime > 0 ? fmtTime(e.solveTime) : "—"}</td>
            <td>${e.eloAtTime ?? "—"}</td>`;
        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);
    console.log("[stats] history rendered, rows:", entries.length);
}

function fmtTime(s) {
    const r = Math.round(s);
    if (r < 60) return `${r}s`;
    return `${Math.floor(r / 60)}m ${r % 60}s`;
}

function fmtDate(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric"
    });
}