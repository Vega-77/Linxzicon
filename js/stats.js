// ============================================================
// stats.js
// Renders the stats page. Solo and multiplayer stats are shown
// in separate sections. History table includes a Mode column.
// ============================================================

import { database } from "./firebase-config.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

export async function loadStats(uid, account) {
    if (!account) {
        const c = document.getElementById("stats-container");
        if (c) c.textContent = "Could not load stats.";
        return;
    }
    renderSummary(account);
    await renderHistory(uid);
}

// ============================================================
// renderSummary — fills both stat grids
// ============================================================
function renderSummary(account) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    // Header
    set("stat-username", account.username);
    set("stat-elo",      account.elo);

    // ── Solo ──
    set("stat-solo-played",    account.soloPlayed);
    set("stat-solo-won",       account.soloWon);
    set("stat-solo-avg-words", account.soloWon > 0 ? account.soloAvgWords.toFixed(1) : "—");
    set("stat-solo-avg-time",  account.soloWon > 0 ? fmtTime(account.soloAvgTime) : "—");
    set("stat-solo-best-time", account.soloBestTime > 0 ? fmtTime(account.soloBestTime) : "—");

    // ── Multiplayer ──
    set("stat-multi-played",    account.multiPlayed);
    set("stat-multi-won",       account.multiWon);
    set("stat-multi-lost",      account.multiLost);
    set("stat-multi-winrate",   account.multiWinRate);
    set("stat-multi-avg-words", account.multiWon > 0 ? account.multiAvgWords.toFixed(1) : "—");
    set("stat-multi-avg-time",  account.multiWon > 0 ? fmtTime(account.multiAvgTime) : "—");
    set("stat-multi-streak",    account.winStreak);
    set("stat-multi-cur-streak",account.currentStreak);
}

// ============================================================
// renderHistory — last 20 games with Mode column
// ============================================================
async function renderHistory(uid) {
    const container = document.getElementById("history-container");
    if (!container) return;

    const snap = await get(ref(database, `users/${uid}/history`));

    if (!snap.exists()) {
        container.innerHTML = "<p class='no-history'>No games played yet.</p>";
        return;
    }

    const entries = Object.values(snap.val()).reverse().slice(0, 20);

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
        const mode = e.mode === "solo" ? "Solo" : "Multi";
        tr.innerHTML = `
            <td>${fmtDate(e.date)}</td>
            <td><span class="mode-badge mode-${e.mode ?? 'solo'}">${mode}</span></td>
            <td class="${e.won ? "result-win" : "result-loss"}">${e.won ? "Win ✓" : "Loss"}</td>
            <td>${e.wordsUsed > 0 ? e.wordsUsed : "—"}</td>
            <td>${e.solveTime > 0 ? fmtTime(e.solveTime) : "—"}</td>
            <td>${e.eloAtTime ?? "—"}</td>`;
        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);
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