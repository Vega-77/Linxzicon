// ============================================================
// graph.js
// Graph data structure for the Linxicon game board.
// Uses an adjacency-list representation (Map of Sets).
//
// Nodes are words. Edges are created when two words are
// neighbors according to the GloVe top-25 file (via glove.js).
// ============================================================

// ============================================================
// GraphNode
// One word on the board.
// x, y, vx, vy are used by render.js for physics simulation.
// ============================================================
export class GraphNode {
    constructor(word) {
        this.word      = word.toLowerCase();
        this.neighbors = new Set(); // Set<string> of connected word strings

        // Force-directed layout state (updated every frame by render.js)
        this.x  = 0;
        this.y  = 0;
        this.vx = 0; // velocity x
        this.vy = 0; // velocity y
    }
}

// ============================================================
// Graph
// Adjacency-list graph keyed by word string.
// ============================================================
export class Graph {
    constructor() {
        // Map<string, GraphNode>
        this.nodes = new Map();
    }

    // ----------------------------------------------------------
    // addNode
    // Adds a word to the board and draws edges to any words in
    // the connections array (which comes from glove.getConnections).
    // Returns the new GraphNode.
    // Does nothing and returns the existing node if the word is
    // already on the board.
    // ----------------------------------------------------------
    addNode(word, connections = []) {
        const lower = word.toLowerCase();
        if (this.nodes.has(lower)) return this.nodes.get(lower);

        const node = new GraphNode(lower);

        // Scatter new nodes near the canvas center so the physics
        // simulation has somewhere to start before it settles.
        node.x = 450 + (Math.random() - 0.5) * 200;
        node.y = 260 + (Math.random() - 0.5) * 200;

        this.nodes.set(lower, node);

        // Create bidirectional edges to every connected word
        for (const connWord of connections) {
            this.addEdge(lower, connWord);
        }

        return node;
    }

    // ----------------------------------------------------------
    // addEdge
    // Creates a bidirectional edge between two existing words.
    // Silently does nothing if either word is not on the board.
    // ----------------------------------------------------------
    addEdge(word1, word2) {
        const n1 = this.nodes.get(word1.toLowerCase());
        const n2 = this.nodes.get(word2.toLowerCase());
        if (!n1 || !n2) return;

        n1.neighbors.add(n2.word);
        n2.neighbors.add(n1.word);
    }

    // ----------------------------------------------------------
    // hasNode
    // Returns true if the word is already on the board.
    // ----------------------------------------------------------
    hasNode(word) {
        return this.nodes.has(word.toLowerCase());
    }

    // ----------------------------------------------------------
    // getNode
    // Returns the GraphNode for a word, or null.
    // ----------------------------------------------------------
    getNode(word) {
        return this.nodes.get(word.toLowerCase()) ?? null;
    }

    // ----------------------------------------------------------
    // isConnected
    // BFS: checks whether any path exists between word1 and word2.
    // Called after every word addition to test the win condition.
    // O(V + E) where V and E are the current board size.
    // ----------------------------------------------------------
    isConnected(word1, word2) {
        const start = word1.toLowerCase();
        const end   = word2.toLowerCase();

        if (!this.nodes.has(start) || !this.nodes.has(end)) return false;
        if (start === end) return true;

        const visited = new Set([start]);
        const queue   = [start];

        while (queue.length > 0) {
            const current = queue.shift();

            for (const neighbor of this.nodes.get(current).neighbors) {
                if (neighbor === end)           return true;
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }

        return false;
    }

    // ----------------------------------------------------------
    // getPath
    // BFS that returns the shortest path between two words as an
    // array of word strings: e.g. ["cat", "feline", "animal"].
    // Returns null if no path exists.
    // Used by render.js to highlight the winning path in green.
    // ----------------------------------------------------------
    getPath(word1, word2) {
        const start = word1.toLowerCase();
        const end   = word2.toLowerCase();

        if (!this.nodes.has(start) || !this.nodes.has(end)) return null;
        if (start === end) return [start];

        const visited = new Set([start]);
        // Each queue entry is the full path taken to reach that node
        const queue   = [[start]];

        while (queue.length > 0) {
            const path    = queue.shift();
            const current = path[path.length - 1];

            for (const neighbor of this.nodes.get(current).neighbors) {
                if (neighbor === end) return [...path, end]; // path complete

                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    queue.push([...path, neighbor]);
                }
            }
        }

        return null; // no path exists
    }

    // ----------------------------------------------------------
    // wordCount
    // Total number of nodes currently on the board.
    // Displayed in the game UI info bar.
    // ----------------------------------------------------------
    get wordCount() {
        return this.nodes.size;
    }

    // ----------------------------------------------------------
    // getBoardWords
    // Returns a Set<string> of all words currently on the board.
    // Passed to glove.getConnections() when a new word is typed.
    // ----------------------------------------------------------
    getBoardWords() {
        return new Set(this.nodes.keys());
    }
}