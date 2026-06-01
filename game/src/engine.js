/**
 * LinxiconEngine — pure game logic, no I/O.
 *
 * All methods are immutable: they return new state objects and never mutate
 * their inputs. BoardState is a plain JSON-serializable object, safe to store
 * on a server or send over a network.
 *
 * Game rules:
 *   - A board starts with two words: start and target (no edges between them).
 *   - Players add words one at a time.
 *   - When a word is added, it connects to every word already on the board
 *     whose cosine similarity exceeds the adaptive threshold.
 *   - The game is won when any path exists from start to target in the board graph.
 *
 * BoardState shape:
 * {
 *   id:         string,
 *   startWord:  string,        // always words[0]
 *   targetWord: string,        // always words[1]
 *   words:      string[],      // all words on the board, in order of addition
 *   edges:      [i,j,score][], // undirected edges by word index (i < j)
 *   status:     'active'|'won',
 *   adaptiveK:  number,        // threshold sensitivity knob
 * }
 */
export class LinxiconEngine {
  /**
   * @param {Map<string, {vec: Float32Array, mean: number, std: number}>} embeddings
   * @param {{ adaptiveK?: number }} [options]
   */
  constructor(embeddings, options = {}) {
    this._emb = embeddings;
    this._defaultK = options.adaptiveK ?? 1.0;
  }

  // ---------------------------------------------------------------------------
  // Vocabulary queries
  // ---------------------------------------------------------------------------

  hasWord(word) {
    return this._emb.has(word.toLowerCase());
  }

  /**
   * Cosine similarity between two vocabulary words.
   * Returns null if either word is unknown.
   */
  cosineSimilarity(word1, word2) {
    const e1 = this._emb.get(word1.toLowerCase());
    const e2 = this._emb.get(word2.toLowerCase());
    if (!e1 || !e2) return null;
    return _dot(e1.vec, e2.vec);
  }

  /**
   * Returns the cosine similarity between the two words and their adaptive threshold,
   * useful for validating that a proposed word pair makes a reasonable game.
   *
   * A pair whose similarity already exceeds the threshold is a trivial game —
   * players can win immediately by adding any word that's close to either.
   * Recommended starting pairs have similarity well below the threshold.
   *
   * @returns {{ similarity: number, threshold: number, isTrivial: boolean } | null}
   */
  pairSimilarity(word1, word2, adaptiveK) {
    const w1 = word1.toLowerCase();
    const w2 = word2.toLowerCase();
    const e1 = this._emb.get(w1);
    const e2 = this._emb.get(w2);
    if (!e1 || !e2) return null;
    const k = adaptiveK ?? this._defaultK;
    const similarity = _dot(e1.vec, e2.vec);
    const threshold = _edgeThreshold(e1, e2, k);
    return { similarity, threshold, isTrivial: similarity >= threshold };
  }

  // ---------------------------------------------------------------------------
  // Game lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Creates a new board with start and target placed as isolated nodes.
   *
   * @param {string} start
   * @param {string} target
   * @param {{ adaptiveK?: number, id?: string }} [options]
   * @returns {BoardState}
   */
  createGame(start, target, options = {}) {
    const s = start.toLowerCase();
    const t = target.toLowerCase();

    if (!this._emb.has(s)) throw new Error(`Unknown word: "${start}"`);
    if (!this._emb.has(t)) throw new Error(`Unknown word: "${target}"`);
    if (s === t) throw new Error('Start and target must be different words');

    const adaptiveK = options.adaptiveK ?? this._defaultK;
    const id = options.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const state = {
      id,
      startWord: s,
      targetWord: t,
      words: [s, t],
      edges: [],
      status: 'active',
      adaptiveK,
    };

    return state;
  }

  /**
   * Attempts to add a word to the board.
   *
   * @param {BoardState} state
   * @param {string} word
   * @returns {{ state: BoardState, result: AddResult }}
   *
   * AddResult: {
   *   accepted:  boolean,
   *   reason?:   'unknown_word' | 'already_on_board',
   *   newEdges:  [word1, word2, score][],
   *   won:       boolean,
   * }
   */
  addWord(state, word) {
    const w = word.toLowerCase();

    if (!this._emb.has(w)) {
      return { state, result: { accepted: false, reason: 'unknown_word', newEdges: [], won: false } };
    }

    if (state.words.includes(w)) {
      return { state, result: { accepted: false, reason: 'already_on_board', newEdges: [], won: false } };
    }

    const newIndex = state.words.length;
    const newEntry = this._emb.get(w);
    const newEdges = [];

    // Connect to every word already on the board that is similar enough.
    for (let i = 0; i < state.words.length; i++) {
      const existingEntry = this._emb.get(state.words[i]);
      const sim = _dot(newEntry.vec, existingEntry.vec);
      const threshold = _edgeThreshold(newEntry, existingEntry, state.adaptiveK);

      if (sim >= threshold) {
        newEdges.push([i, newIndex, sim]);
      }
    }

    const newWords = [...state.words, w];
    const allEdges = [...state.edges, ...newEdges];

    const newState = {
      ...state,
      words: newWords,
      edges: allEdges,
    };

    const won = _bfsReachable(newState);
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

  /**
   * Returns true if start and target are connected in the current board graph.
   */
  checkWin(state) {
    return _bfsReachable(state);
  }

  // ---------------------------------------------------------------------------
  // Path and metrics
  // ---------------------------------------------------------------------------

  /**
   * BFS shortest path from startWord to targetWord through the board graph.
   * Returns an array of word strings (inclusive), or null if no path exists.
   */
  shortestPath(state) {
    return _bfsPath(state);
  }

  /**
   * Returns { wordsOnBoard, shortestPathLength }.
   * shortestPathLength is null if start and target are not yet connected.
   */
  getMetrics(state) {
    const path = _bfsPath(state);
    return {
      wordsOnBoard: state.words.length,
      shortestPathLength: path ? path.length - 1 : null,
    };
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

/**
 * Per-edge threshold: uses the MORE hub-like word to set the bar.
 * Hub words (high mean similarity) require a stronger connection to get an edge.
 */
function _edgeThreshold(entry1, entry2, adaptiveK) {
  const mean = Math.max(entry1.mean, entry2.mean);
  const std  = Math.max(entry1.std,  entry2.std);
  return mean + adaptiveK * std;
}

function _buildAdj(state) {
  const adj = Array.from({ length: state.words.length }, () => []);
  for (const [i, j] of state.edges) {
    adj[i].push(j);
    adj[j].push(i);
  }
  return adj;
}

function _bfsReachable(state) {
  const startIdx = 0;
  const targetIdx = 1;
  if (state.words.length < 2) return false;

  const adj = _buildAdj(state);
  const visited = new Uint8Array(state.words.length);
  const queue = [startIdx];
  visited[startIdx] = 1;

  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr === targetIdx) return true;
    for (const next of adj[curr]) {
      if (!visited[next]) {
        visited[next] = 1;
        queue.push(next);
      }
    }
  }

  return false;
}

function _bfsPath(state) {
  const startIdx = 0;
  const targetIdx = 1;
  if (state.words.length < 2) return null;

  const adj = _buildAdj(state);
  const prev = new Int32Array(state.words.length).fill(-1);
  const visited = new Uint8Array(state.words.length);
  const queue = [startIdx];
  visited[startIdx] = 1;

  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr === targetIdx) {
      const path = [];
      let node = targetIdx;
      while (node !== -1) {
        path.unshift(state.words[node]);
        node = prev[node];
      }
      return path;
    }
    for (const next of adj[curr]) {
      if (!visited[next]) {
        visited[next] = 1;
        prev[next] = curr;
        queue.push(next);
      }
    }
  }

  return null;
}
