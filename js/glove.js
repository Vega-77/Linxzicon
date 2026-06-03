// ============================================================
// glove.js
// Loads and queries the precomputed GloVe neighbor file.
//
// Expected format of glove_top25.txt (one line per word):
//   king|queen:0.87,monarch:0.81,prince:0.79,...
//
// Parsed into a Map:
//   "king" -> [ {word:"queen", score:0.87}, ... ]
// ============================================================

// neighborMap holds every word's top-25 neighbors after loading.
// Key: lowercase word string
// Value: array of { word: string, score: number }
const neighborMap = new Map();

let loaded = false; // guard against loading the file twice

// ============================================================
// loadGlove
// Fetches and parses glove_top25.txt into neighborMap.
// Must be awaited once before any other function in this
// module is called.
// ============================================================
export async function loadGlove(filepath = "glove_top25.txt") {
    if (loaded) return;

    const response = await fetch(filepath);
    if (!response.ok) {
        throw new Error(`Failed to load GloVe file: ${response.status} ${response.statusText}`);
    }

    const text  = await response.text();
    const lines = text.trim().split("\n");

    for (const line of lines) {
        if (!line.trim()) continue;

        // Each line: "word|neighbor1:score1,neighbor2:score2,..."
        const pipeIdx = line.indexOf("|");
        if (pipeIdx === -1) continue;

        const word        = line.substring(0, pipeIdx).trim().toLowerCase();
        const neighborStr = line.substring(pipeIdx + 1).trim();
        const neighbors   = [];

        for (const entry of neighborStr.split(",")) {
            // Split on the LAST colon so words with colons don't break parsing
            const colonIdx = entry.lastIndexOf(":");
            if (colonIdx === -1) continue;

            const neighborWord  = entry.substring(0, colonIdx).trim().toLowerCase();
            const neighborScore = parseFloat(entry.substring(colonIdx + 1));

            if (neighborWord && !isNaN(neighborScore)) {
                neighbors.push({ word: neighborWord, score: neighborScore });
            }
        }

        neighborMap.set(word, neighbors);
    }

    loaded = true;
    console.log(`GloVe loaded: ${neighborMap.size} words`);
}

// ============================================================
// getNeighbors
// Returns the top-25 neighbor array for a word.
// Returns [] if the word is not in the vocabulary.
// ============================================================
export function getNeighbors(word) {
    return neighborMap.get(word.toLowerCase()) ?? [];
}

// ============================================================
// isInVocabulary
// Returns true if the word exists in the neighbor map.
// Use this to validate user input before adding to the graph.
// ============================================================
export function isInVocabulary(word) {
    return neighborMap.has(word.toLowerCase());
}

// ============================================================
// getConnections
// Given a new word and the set of words already on the board,
// returns an array of board words that should be connected
// to the new word by an edge.
//
// Two words connect if either:
//   (A) the new word appears in a board word's top-25, OR
//   (B) a board word appears in the new word's top-25
//
// This bidirectional check handles asymmetry in the top-25
// lists (A can be in B's top-25 without B being in A's).
//
//   newWord    — word just typed by the player (string)
//   boardWords — Set<string> of words currently on the board
//
// Returns: string[] of board words to connect to
// ============================================================
export function getConnections(newWord, boardWords) {
    const lower       = newWord.toLowerCase();
    const connections = new Set();

    // (B) Is any board word in newWord's top-25?
    for (const { word } of getNeighbors(lower)) {
        if (boardWords.has(word)) {
            connections.add(word);
        }
    }

    // (A) Is newWord in any board word's top-25?
    // Must iterate ALL neighbors of EACH board word — do not break early.
    for (const boardWord of boardWords) {
        for (const { word } of getNeighbors(boardWord)) {
            if (word === lower) {
                connections.add(boardWord);
                break; // found a match for this board word; move to next
            }
        }
    }

    return Array.from(connections);
}