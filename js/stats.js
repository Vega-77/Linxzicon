// ============================================================
// js/stats.js — Fully Colored Axes and Labels Edition
// Includes drawn axes, colored text overlays, and colorful math summaries.
// ============================================================

import { database } from "./firebase-config.js";
import { ref, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

export async function loadStats(uid, account) {
    if (!account) {
        console.error("[stats] no account provided to loadStats");
        const c = document.getElementById("history-container");
        if (c) c.innerHTML = "<p class='no-history'>Could not load stats — not logged in?</p>";
        return;
    }

    renderSummary(account);
    await renderHistory(uid, account);
}

function renderSummary(account) {
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    };

    setText("stat-username",         account.username);
    setText("stat-elo",              account.elo);

    // Solo Mode Cards
    setText("stat-solo-played",      account.soloPlayed);
    setText("stat-solo-won",         account.soloWon);
    setText("stat-solo-avg-words",   account.soloAvgWords > 0 ? account.soloAvgWords.toFixed(1) : "—");
    setText("stat-solo-avg-time",    account.soloAvgTime > 0  ? fmtTime(account.soloAvgTime)  : "—");
    setText("stat-solo-best-time",   account.soloBestTime > 0 ? fmtTime(account.soloBestTime) : "—");

    // Multiplayer Cards
    setText("stat-multi-played",     account.multiPlayed);
    setText("stat-multi-won",        account.multiWon);
    setText("stat-multi-lost",       account.multiLost);
    
    const multiRate = account.multiPlayed > 0 ? ((account.multiWon / account.multiPlayed) * 100).toFixed(1) + "%" : "—";
    setText("stat-multi-winrate",    multiRate);
    setText("stat-multi-avg-words",  account.multiAvgWords > 0 ? account.multiAvgWords.toFixed(1) : "—");
    setText("stat-multi-avg-time",   account.multiAvgTime > 0  ? fmtTime(account.multiAvgTime)  : "—");
    setText("stat-multi-streak",     account.multiBestStreak);
    setText("stat-multi-cur-streak",  account.multiCurStreak);
}

async function renderHistory(uid, account) {
    const container = document.getElementById("history-container");
    if (!container) return;

    let entries = [];
    try {
        const snap = await get(ref(database, `users/${uid}/history`));
        if (snap.exists()) {
            entries = Object.values(snap.val());
            entries.sort((a, b) => new Date(b.date) - new Date(a.date));
        }
    } catch (err) {
        container.innerHTML = "<p class='no-history'>Failed to load match history records.</p>";
        return;
    }

    if (entries.length === 0) {
        container.innerHTML = "<p class='no-history'>No matches played yet. Go play a round!</p>";
        return;
    }

    const displayEntries = entries.slice(0, 20);
    const table = document.createElement("table");
    table.className = "history-table";
    table.innerHTML = `
        <thead>
            <tr>
                <th>Date</th>
                <th>Mode</th>
                <th>Result</th>
                <th>Words (Total)</th>
                <th>Start ➔ End Word</th>
                <th>Path Taken</th>
                <th>Opponent</th>
                <th>Time</th>
                <th>Elo After</th>
            </tr>
        </thead>`;

    const tbody = document.createElement("tbody");
    for (const e of displayEntries) {
        const tr = document.createElement("tr");
        const isSolo = e.mode === "solo" || !e.mode;
        tr.className = e.won ? "row-win" : (isSolo ? "" : "row-loss");

        const modeName = e.mode === "multiplayer" ? "Multi" : (e.mode === "daily" ? "Daily" : "Solo");
        const modeClass = e.mode === "multiplayer" ? "mode-multiplayer" : (e.mode === "daily" ? "mode-daily" : "mode-solo");
        
        const startW = e.startWord ?? "—";
        const endW = e.endWord ?? "—";
        const opponentDisp = e.opponentUsername ?? (e.opponentElo ? `Elo ${e.opponentElo}` : "—");
        
        let pathString = "—";
        if (e.path && Array.isArray(e.path)) {
            pathString = e.path.join(" ➔ ");
        } else if (e.bestPathLength) {
            pathString = `[${e.bestPathLength} hops]`;
        }

        tr.innerHTML = `
            <td style="white-space:nowrap">${fmtDate(e.date)}</td>
            <td><span class="mode-badge ${modeClass}">${modeName}</span></td>
            <td class="${e.won ? "result-win" : (isSolo ? "" : "result-loss")}">${e.won ? "Win ✓" : "Loss"}</td>
            <td>${e.wordsUsed > 0 ? e.wordsUsed : "—"}</td>
            <td style="font-size:0.8rem; font-weight:500; white-space:nowrap">${startW} ➔ ${endW}</td>
            <td style="font-size:0.75rem; color:var(--text-muted); max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${pathString}">${pathString}</td>
            <td style="white-space:nowrap">${opponentDisp}</td>
            <td>${e.solveTime > 0 ? fmtTime(e.solveTime) : "—"}</td>
            <td>${e.eloAtTime ?? "—"}</td>`;
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);

    processAdvancedAnalytics(entries, account);
}

function processAdvancedAnalytics(entries, account) {
    const chronoEntries = [...entries].reverse();
    const colors = {
        indigo: "#818cf8", // lightened for dark mode contrast
        amber: "#fbbf24",
        emerald: "#34d399",
        rose: "#fb7185",
        textMuted: "#94a3b8"
    };

    const initCanvas = (id) => {
        const canvas = document.getElementById(id);
        if (!canvas) return null;
        const ctx = canvas.getContext("2d");
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        return { ctx, w: rect.width, h: rect.height };
    };

    // Helper: Draws labeled X and Y axes on the canvas
    const drawAxes = (ctx, w, h, xLabel, yLabel, labelColor) => {
        const padX = 40;
        const padY = 30;

        // Axis Lines
        ctx.strokeStyle = "rgba(255,255,255,0.2)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padX, 10); ctx.lineTo(padX, h - padY); // Y Axis
        ctx.moveTo(padX, h - padY); ctx.lineTo(w - 10, h - padY); // X Axis
        ctx.stroke();

        // X Axis Label
        ctx.fillStyle = labelColor || colors.textMuted;
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(xLabel, padX + (w - padX) / 2, h - 8);

        // Y Axis Label (Rotated)
        ctx.save();
        ctx.translate(12, 10 + (h - padY) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText(yLabel, 0, 0);
        ctx.restore();

        ctx.textAlign = "left"; // Reset alignment
        return { padX, padY };
    };

    // --- FEATURE 1: Elo History ---
    (() => {
        const c = initCanvas("canvas-elo-history");
        if (!c) return;
        
        const eloHistory = chronoEntries.filter(e => e.mode === "multiplayer" && e.eloAtTime !== undefined).map(e => e.eloAtTime);
        if (eloHistory.length === 0) eloHistory.push(account.elo);
        if (eloHistory.length === 1) eloHistory.unshift(1000);

        const { padX, padY } = drawAxes(c.ctx, c.w, c.h, "Matches (Oldest → Newest)", "Elo Rating", colors.indigo);

        const min = Math.min(...eloHistory) - 30;
        const max = Math.max(...eloHistory) + 30;
        const range = max - min || 60;
        const stepX = (c.w - padX - 15) / Math.max(eloHistory.length - 1, 1);

        c.ctx.strokeStyle = colors.indigo;
        c.ctx.lineWidth = 2.5;
        c.ctx.beginPath();
        eloHistory.forEach((val, i) => {
            const x = padX + 5 + i * stepX;
            const y = c.h - padY - ((val - min) / range) * (c.h - padY - 20);
            if (i === 0) c.ctx.moveTo(x, y); else c.ctx.lineTo(x, y);
            
            // Draw numeric Elo labels directly on the points occasionally
            if (i === 0 || i === eloHistory.length - 1) {
                c.ctx.fillStyle = colors.indigo;
                c.ctx.font = "bold 9px sans-serif";
                c.ctx.fillText(val, x - 10, y - 8);
            }
        });
        c.ctx.stroke();

        const summaryEl = document.getElementById("summary-elo-history");
        if (summaryEl) summaryEl.innerHTML = `Tracked <span style="color:${colors.indigo}; font-weight:bold">${eloHistory.length}</span> records. Ending rating: <span style="color:${colors.indigo}; font-weight:bold">${eloHistory[eloHistory.length - 1]}</span>`;
    })();

    // --- FEATURE 2: Words vs Path Length Scatter ---
    (() => {
        const c = initCanvas("canvas-scatter-words");
        if (!c) return;
        
        const points = chronoEntries.map(e => ({
            x: e.wordsUsed || 0,
            y: e.bestPathLength || (e.path ? e.path.length : (e.won ? Math.round((e.wordsUsed || 1) * 0.5) : 0))
        })).filter(p => p.x > 0 && p.y > 0);

        const { padX, padY } = drawAxes(c.ctx, c.w, c.h, "Total Words Played", "Best Path Length", colors.amber);

        if (points.length === 0) return;
        const maxX = Math.max(...points.map(p => p.x), 10) + 4;
        const maxY = Math.max(...points.map(p => p.y), 6) + 2;

        c.ctx.fillStyle = colors.amber;
        points.forEach(p => {
            const cx = padX + 5 + (p.x / maxX) * (c.w - padX - 20);
            const cy = c.h - padY - (p.y / maxY) * (c.h - padY - 20);
            c.ctx.beginPath();
            c.ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            c.ctx.fill();
        });
    })();

    // --- FEATURE 3 & 4: Word Deployment Totals ---
    (() => {
        let totalWords = 0;
        const frequencyMap = {};
        
        chronoEntries.forEach(e => {
            totalWords += (e.wordsUsed || 0);
            if (e.path && Array.isArray(e.path)) {
                e.path.forEach(w => {
                    const clean = w.toLowerCase().trim();
                    if (clean) frequencyMap[clean] = (frequencyMap[clean] || 0) + 1;
                });
            }
        });

        const totalEl = document.getElementById("stat-total-words-used");
        if (totalEl) totalEl.textContent = totalWords;

        const wordsSorted = Object.entries(frequencyMap).sort((a,b) => b[1] - a[1]).slice(0, 5);
        const mostUsedContainer = document.getElementById("container-most-used-words");
        if (mostUsedContainer) {
            if (wordsSorted.length === 0) {
                mostUsedContainer.innerHTML = "<span style='color:var(--text-muted); font-size:0.8rem;'>No path word arrays logged yet</span>";
            } else {
                mostUsedContainer.innerHTML = wordsSorted.map(item => `
                    <span class="word-list-tag">${item[0]} <strong style="color:var(--amber)">(${item[1]})</strong></span>
                `).join("");
            }
        }
    })();

    // --- FEATURE 5: Distribution Histogram ---
    (() => {
        const c = initCanvas("canvas-path-dist");
        if (!c) return;
        
        const lengths = chronoEntries.map(e => e.bestPathLength || (e.path ? e.path.length : 0)).filter(l => l > 0);
        const { padX, padY } = drawAxes(c.ctx, c.w, c.h, "Path Length (Hops)", "Games Count", colors.emerald);

        if (lengths.length === 0) return;

        const meanVal = lengths.reduce((a,b)=>a+b,0) / lengths.length;
        const sorted = [...lengths].sort((a,b)=>a-b);
        const mid = Math.floor(sorted.length / 2);
        const medianVal = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        const variance = lengths.reduce((a,b) => a + Math.pow(b - meanVal, 2), 0) / lengths.length;
        const stdDevVal = Math.sqrt(variance);

        const sumEl = document.getElementById("summary-path-dist");
        if (sumEl) sumEl.innerHTML = `Mean: <span style="color:${colors.emerald}; font-weight:bold">${meanVal.toFixed(1)}</span> | Median: <span style="color:${colors.emerald}; font-weight:bold">${medianVal}</span> | Std Dev: <span style="color:${colors.emerald}; font-weight:bold">${stdDevVal.toFixed(1)}</span>`;

        const buckets = new Array(9).fill(0);
        lengths.forEach(l => { if (l < 9) buckets[l]++; else buckets[8]++; });
        const maxBucket = Math.max(...buckets, 1);
        const barW = (c.w - padX - 10) / 8;

        for (let i = 1; i <= 8; i++) {
            const barH = (buckets[i] / maxBucket) * (c.h - padY - 20);
            const x = padX + 2 + (i - 1) * barW;
            
            c.ctx.fillStyle = colors.emerald;
            c.ctx.fillRect(x, c.h - padY - barH, barW - 4, barH);
            
            // Draw colored bucket label
            c.ctx.fillStyle = colors.emerald;
            c.ctx.font = "bold 10px sans-serif";
            c.ctx.textAlign = "center";
            c.ctx.fillText(i === 8 ? "8+" : i, x + (barW - 4)/2, c.h - padY + 14);
            c.ctx.textAlign = "left";
        }
    })();

    // --- FEATURE 6: Opponent Win/Loss Matrix ---
    (() => {
        const opponents = {};
        chronoEntries.forEach(e => {
            if (e.mode === "multiplayer" && e.opponentUsername) {
                const op = e.opponentUsername;
                if (!opponents[op]) opponents[op] = { name: op, count: 0, wins: 0, losses: 0 };
                opponents[op].count++;
                if (e.won) opponents[op].wins++; else opponents[op].losses++;
            }
        });

        const topOpponents = Object.values(opponents).sort((a,b) => b.count - a.count).slice(0, 5);
        const tbody = document.getElementById("tbody-opponent-history");
        if (tbody && topOpponents.length > 0) {
            tbody.innerHTML = topOpponents.map(o => `
                <tr>
                    <td style="font-weight:600;">${o.name}</td>
                    <td>${o.count}</td>
                    <td><span class="badge-win">${o.wins}W</span> - <span class="badge-loss">${o.losses}L</span></td>
                </tr>
            `).join("");
        }
    })();

    // --- FEATURE 8: Multiplayer Solve Time Distribution ---
    (() => {
        const c = initCanvas("canvas-time-dist");
        if (!c) return;

        const onlineTimes = chronoEntries.filter(e => e.mode === "multiplayer" && e.won && e.solveTime > 0).map(e => e.solveTime);
        const { padX, padY } = drawAxes(c.ctx, c.w, c.h, "Solve Time (Seconds)", "Games Count", colors.rose);

        const n = onlineTimes.length;
        if (n === 0) return;

        const meanVal = onlineTimes.reduce((a,b)=>a+b, 0) / n;
        const sorted = [...onlineTimes].sort((a,b)=>a-b);
        
        const mid = Math.floor(n / 2);
        const medianVal = n % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        
        const q1 = sorted[Math.floor(n * 0.25)];
        const q3 = sorted[Math.floor(n * 0.75)];
        const variance = onlineTimes.reduce((a,b) => a + Math.pow(b - meanVal, 2), 0) / n;
        const stdDevVal = Math.sqrt(variance);

        const sumEl = document.getElementById("summary-time-dist");
        if (sumEl) sumEl.innerHTML = `Mean: <span style="color:${colors.rose}; font-weight:bold">${meanVal.toFixed(1)}s</span> | Med: <span style="color:${colors.rose}; font-weight:bold">${medianVal}s</span> | Q1/Q3: <span style="color:${colors.rose}; font-weight:bold">${q1}s/${q3}s</span> | Std Dev: <span style="color:${colors.rose}; font-weight:bold">${stdDevVal.toFixed(1)}s</span>`;

        const maxTime = Math.max(...onlineTimes, 60);
        const binCount = 6;
        const binWidth = maxTime / binCount;
        const bins = new Array(binCount).fill(0);

        onlineTimes.forEach(t => {
            const idx = Math.min(Math.floor(t / binWidth), binCount - 1);
            bins[idx]++;
        });

        const maxBin = Math.max(...bins, 1);
        const barW = (c.w - padX - 10) / binCount;

        bins.forEach((count, i) => {
            const barH = (count / maxBin) * (c.h - padY - 20);
            const x = padX + 2 + i * barW;
            
            c.ctx.fillStyle = colors.rose;
            c.ctx.fillRect(x, c.h - padY - barH, barW - 4, barH);

            // Colored X-axis bucket labels
            c.ctx.fillStyle = colors.rose;
            c.ctx.font = "bold 9px sans-serif";
            c.ctx.textAlign = "center";
            c.ctx.fillText(`${Math.round(i * binWidth)}s`, x + (barW - 4)/2, c.h - padY + 14);
            c.ctx.textAlign = "left";
        });
    })();
}

function fmtTime(seconds) {
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function fmtDate(dateStr) {
    if (!dateStr) return "—";
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return "—";
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (_) {
        return "—";
    }
}