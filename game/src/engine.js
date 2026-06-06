/**
 * LinxiconEngine — pure game logic, no I/O.
 *
 * adaptiveK controls how strict the edge threshold is.
 * Higher K = harder connections. Default raised to 2.0
 * (was 1.0 in the original) so only genuinely close words connect.
 *
 * Threshold formula per edge:
 *   max(mean_A, mean_B) + K * max(std_A, std_B)
 *
 * At K=2.0 only the top ~2% most similar pairs form edges,
 * giving a satisfying but achievable challenge.
 */
export class LinxiconEngine {
  /**
   * @param {Map<string, {vec: Float32Array, mean: number, std: number}>} embeddings
   * @param {{ adaptiveK?: number }} [options]
   */
  constructor(embeddings, options = {}) {
    this._emb      = embeddings;
    this._defaultK = options.adaptiveK ?? 2.0; // raised from 1.0 → 2.0
  }

  // ---------------------------------------------------------------------------
  // Vocabulary queries
  // ---------------------------------------------------------------------------

  hasWord(word) {
    return this._emb.has(word.toLowerCase());
  }

  randomWords(n) {
    if (!this._wordList) this._wordList = [...this._emb.keys()];
    const result = [], len = this._wordList.length;
    for (let i = 0; i < n; i++)
      result.push(this._wordList[Math.floor(Math.random() * len)]);
    return result;
  }

  cosineSimilarity(word1, word2) {
    const e1 = this._emb.get(word1.toLowerCase());
    const e2 = this._emb.get(word2.toLowerCase());
    if (!e1 || !e2) return null;
    return _dot(e1.vec, e2.vec);
  }

  pairSimilarity(word1, word2, adaptiveK) {
    const w1 = word1.toLowerCase();
    const w2 = word2.toLowerCase();
    const e1 = this._emb.get(w1);
    const e2 = this._emb.get(w2);
    if (!e1 || !e2) return null;
    const k         = adaptiveK ?? this._defaultK;
    const similarity = _dot(e1.vec, e2.vec);
    const threshold  = _edgeThreshold(e1, e2, k);
    return { similarity, threshold, isTrivial: similarity >= threshold };
  }

  // ---------------------------------------------------------------------------
  // Game lifecycle
  // ---------------------------------------------------------------------------

  createGame(start, target, options = {}) {
    const s = start.toLowerCase();
    const t = target.toLowerCase();

    if (!this._emb.has(s)) throw new Error(`Unknown word: "${start}"`);
    if (!this._emb.has(t)) throw new Error(`Unknown word: "${target}"`);
    if (s === t) throw new Error('Start and target must be different words');

    const adaptiveK = options.adaptiveK ?? this._defaultK;
    const id = options.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return { id, startWord: s, targetWord: t, words: [s, t], edges: [], status: 'active', adaptiveK };
  }

  addWord(state, word) {
    const w = word.toLowerCase();

    if (!this._emb.has(w)) {
      return { state, result: { accepted: false, reason: 'unknown_word',    newEdges: [], won: false } };
    }
    if (state.words.includes(w)) {
      return { state, result: { accepted: false, reason: 'already_on_board', newEdges: [], won: false } };
    }

    const newIndex  = state.words.length;
    const newEntry  = this._emb.get(w);
    const newEdges  = [];

    for (let i = 0; i < state.words.length; i++) {
      const existingEntry = this._emb.get(state.words[i]);
      const sim           = _dot(newEntry.vec, existingEntry.vec);
      const threshold     = _edgeThreshold(newEntry, existingEntry, state.adaptiveK);
      if (sim >= threshold) newEdges.push([i, newIndex, sim]);
    }

    const newWords  = [...state.words, w];
    const allEdges  = [...state.edges, ...newEdges];
    const newState  = { ...state, words: newWords, edges: allEdges };
    const won       = _bfsReachable(newState);
    const finalState = won ? { ...newState, status: 'won' } : newState;

    return {
      state: finalState,
      result: {
        accepted: true,
        newEdges: newEdges.map(([i, j, score]) => [newWords[i], newWords[j], score]),
        won,
      },
    };
  }

  checkWin(state)    { return _bfsReachable(state); }
  shortestPath(state){ return _bfsPath(state); }

  getMetrics(state) {
    const path = _bfsPath(state);
    return { wordsOnBoard: state.words.length, shortestPathLength: path ? path.length - 1 : null };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _dot(v1, v2) {
  let sum = 0;
  for (let i = 0; i < v1.length; i++) sum += v1[i] * v2[i];
  return sum;
}

function _edgeThreshold(e1, e2, k) {
  return Math.max(e1.mean, e2.mean) + k * Math.max(e1.std, e2.std);
}

function _buildAdj(state) {
  const adj = Array.from({ length: state.words.length }, () => []);
  for (const [i, j] of state.edges) { adj[i].push(j); adj[j].push(i); }
  return adj;
}

function _bfsReachable(state) {
  if (state.words.length < 2) return false;
  const adj     = _buildAdj(state);
  const visited = new Uint8Array(state.words.length);
  const queue   = [0];
  visited[0]    = 1;
  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr === 1) return true;
    for (const next of adj[curr]) {
      if (!visited[next]) { visited[next] = 1; queue.push(next); }
    }
  }
  return false;
}

function _bfsPath(state) {
  if (state.words.length < 2) return null;
  const adj     = _buildAdj(state);
  const prev    = new Int32Array(state.words.length).fill(-1);
  const visited = new Uint8Array(state.words.length);
  const queue   = [0];
  visited[0]    = 1;
  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr === 1) {
      const path = [];
      let node   = 1;
      while (node !== -1) { path.unshift(state.words[node]); node = prev[node]; }
      return path;
    }
    for (const next of adj[curr]) {
      if (!visited[next]) { visited[next] = 1; prev[next] = curr; queue.push(next); }
    }
  }
  return null;
}