import { loadGlove, isEmbeddingsLoaded } from './glove.js';

const EMBEDDINGS_PATH  = 'game/data/embeddings.bin';
const EMBEDDINGS_CACHE = 'linxicon-embeddings-v3';
const CONSENT_KEY      = 'linxicon-consent';

let _embeddingsPromise = null;
let _resolveConsent    = null;
let _consentPromise    = null;

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtMB(bytes)  { return (bytes / 1_048_576).toFixed(1) + ' MB'; }
function fmtETA(secs)  {
    if (!isFinite(secs) || secs <= 0) return '';
    if (secs < 60) return `~${Math.ceil(secs)}s remaining`;
    return `~${Math.floor(secs / 60)}m ${Math.ceil(secs % 60)}s remaining`;
}

async function isCached() {
    if (!('caches' in globalThis)) return false;
    try {
        const c = await caches.open(EMBEDDINGS_CACHE);
        return !!(await c.match(EMBEDDINGS_PATH));
    } catch { return false; }
}

// ── progress bar ─────────────────────────────────────────────────────────────

function createProgressBar() {
    const bar = document.createElement('div');
    bar.className = 'dl-progress-bar';
    bar.innerHTML = `
        <div class="dl-progress-track">
            <div class="dl-progress-fill" id="dl-fill"></div>
        </div>
        <div class="dl-progress-label" id="dl-label">Downloading… 0%</div>`;
    document.body.appendChild(bar);
    return bar;
}

function updateProgressBar(bar, loaded, total) {
    const pct  = total > 0 ? Math.round((loaded / total) * 100) : 0;
    const fill  = bar.querySelector('#dl-fill');
    const label = bar.querySelector('#dl-label');
    fill.style.width = pct + '%';
    const sizePart = total > 0 ? `${fmtMB(loaded)} / ${fmtMB(total)}` : fmtMB(loaded);
    label.textContent = `${pct}%  •  ${sizePart}`;
}

function updateETA(bar, loaded, total, startTime) {
    const elapsed = (Date.now() - startTime) / 1000;
    const label   = bar.querySelector('#dl-label');
    const pct     = total > 0 ? Math.round((loaded / total) * 100) : 0;
    const sizePart = total > 0 ? `${fmtMB(loaded)} / ${fmtMB(total)}` : fmtMB(loaded);
    let etaPart = '';
    if (elapsed > 1 && loaded > 0 && total > loaded) {
        const bps = loaded / elapsed;
        etaPart = '  •  ' + fmtETA((total - loaded) / bps);
    }
    label.textContent = `${pct}%  •  ${sizePart}${etaPart}`;
}

function flashComplete(bar) {
    const fill  = bar.querySelector('#dl-fill');
    const label = bar.querySelector('#dl-label');
    fill.style.width = '100%';
    label.textContent = '✓  Ready!';
    bar.classList.add('dl-progress-bar--done');
    setTimeout(() => {
        bar.classList.add('dl-progress-bar--fade');
        setTimeout(() => bar.remove(), 600);
    }, 1200);
}

// ── consent modal ────────────────────────────────────────────────────────────

function showConsentModal() {
    _consentPromise = new Promise(resolve => { _resolveConsent = resolve; });

    const overlay = document.createElement('div');
    overlay.className = 'dl-consent-overlay';
    overlay.innerHTML = `
        <div class="dl-consent-card">
            <div class="dl-consent-icon">📦</div>
            <h2 class="dl-consent-title">One-time download required</h2>
            <p class="dl-consent-body">
                Linxzicon uses an <strong>80 MB</strong> word-embeddings file to power the game.
                It downloads once and is cached locally — future visits are instant.
            </p>
            <button class="btn btn-primary dl-consent-accept" id="dl-accept">
                Download Now&nbsp; <span style="opacity:0.7;font-size:0.8em;">(~80 MB)</span>
            </button>
            <button class="btn btn-ghost dl-consent-skip" id="dl-skip">Remind me later</button>
        </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#dl-accept').addEventListener('click', () => {
        localStorage.setItem(CONSENT_KEY, 'granted');
        overlay.classList.add('dl-consent-overlay--hide');
        setTimeout(() => overlay.remove(), 300);
        _resolveConsent(true);
    });

    overlay.querySelector('#dl-skip').addEventListener('click', () => {
        overlay.classList.add('dl-consent-overlay--hide');
        setTimeout(() => overlay.remove(), 300);
        _resolveConsent(false);
    });

    return _consentPromise;
}

// ── core ─────────────────────────────────────────────────────────────────────

function startDownload() {
    if (_embeddingsPromise) return _embeddingsPromise;

    const bar       = createProgressBar();
    const startTime = Date.now();
    let   intervalId;

    _embeddingsPromise = loadGlove(EMBEDDINGS_PATH, ({ loaded, total }) => {
        updateProgressBar(bar, loaded, total);
    }).then(() => {
        clearInterval(intervalId);
        flashComplete(bar);
    }).catch(err => {
        clearInterval(intervalId);
        const label = bar.querySelector('#dl-label');
        if (label) label.textContent = '⚠ Download failed — refresh to retry';
        bar.classList.add('dl-progress-bar--error');
        throw err;
    });

    // Tick ETA every second using last-known loaded/total stored on bar
    intervalId = setInterval(() => {
        const fill  = bar.querySelector('#dl-fill');
        if (!fill) { clearInterval(intervalId); return; }
        const pct   = parseFloat(fill.style.width) || 0;
        const label = bar.querySelector('#dl-label');
        if (!label) return;
        // Re-parse current numbers from label for ETA update
        const elapsed = (Date.now() - startTime) / 1000;
        const m = label.textContent.match(/([\d.]+) MB \/ ([\d.]+) MB/);
        if (m) {
            const loaded = parseFloat(m[1]) * 1_048_576;
            const total  = parseFloat(m[2]) * 1_048_576;
            if (elapsed > 1 && loaded > 0 && total > loaded) {
                const bps     = loaded / elapsed;
                const etaPart = fmtETA((total - loaded) / bps);
                label.textContent = `${pct}%  •  ${fmtMB(loaded)} / ${fmtMB(total)}  •  ${etaPart}`;
            }
        }
    }, 1000);

    return _embeddingsPromise;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Call once per page (non-blocking).
 * Checks consent/cache, shows consent modal if needed, starts download.
 */
export async function initDownloadManager() {
    if (isEmbeddingsLoaded()) return;

    // Already cached — start silently (fast parse, no progress bar needed)
    if (await isCached()) {
        _embeddingsPromise = loadGlove(EMBEDDINGS_PATH);
        return;
    }

    // Already consented in a prior session — start with progress bar
    if (localStorage.getItem(CONSENT_KEY) === 'granted') {
        startDownload();
        return;
    }

    // No consent yet — show modal (non-blocking; download starts if user accepts)
    showConsentModal().then(accepted => {
        if (accepted) startDownload();
    });
}

/**
 * Returns a Promise that resolves when the engine is ready.
 * Pages call this instead of loadGlove() directly.
 * If consent hasn't been given yet, waits for the user to decide.
 */
export async function awaitEmbeddings() {
    if (isEmbeddingsLoaded()) return;

    // If download already in flight, wait for it
    if (_embeddingsPromise) return _embeddingsPromise;

    // Download not started yet — need consent first
    if (localStorage.getItem(CONSENT_KEY) !== 'granted' && !(await isCached())) {
        // Show modal if not already shown; wait for user decision
        if (!_consentPromise) showConsentModal();
        const accepted = await _consentPromise;
        if (!accepted) {
            throw new Error('embeddings-declined');
        }
    }

    return startDownload();
}
