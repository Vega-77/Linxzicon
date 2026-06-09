import { database } from './firebase-config.js';
import { ref, get, onValue }
    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

// Defaults used when Firebase has no value or can't be reached
export const CONFIG_DEFAULTS = {
    adaptiveK:      3.5,
    pairVocabLimit: 40000,
};

let _config    = { ...CONFIG_DEFAULTS };
const _callbacks = [];

/**
 * Load game config from Firebase once, then keep it in sync.
 * Call early in the page lifecycle (before any game logic runs).
 */
export async function initGameConfig() {
    try {
        const snap = await get(ref(database, 'config/game'));
        if (snap.exists()) _config = { ...CONFIG_DEFAULTS, ...snap.val() };
    } catch (_) {}

    onValue(ref(database, 'config/game'), (snap) => {
        if (!snap.exists()) return;
        _config = { ...CONFIG_DEFAULTS, ...snap.val() };
        console.log('[config] updated:', _config);
        for (const cb of _callbacks) cb({ ..._config });
    });
}

/** Returns a shallow copy of the current config. */
export function getConfig() { return { ..._config }; }

/** Register a callback invoked whenever Firebase pushes a config change. */
export function onConfigChange(cb) { _callbacks.push(cb); }
