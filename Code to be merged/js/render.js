// ============================================================
// render.js
// Force-directed graph renderer on an HTML5 Canvas.
//
// Physics model each frame:
//   1. Every pair of nodes repels each other (Coulomb-like)
//   2. Every edge acts as a spring pulling its two nodes together
//   3. A weak gravity nudges all nodes toward the canvas center
//   4. Velocity is damped so the graph eventually settles
// ============================================================

// ── Physics constants ─────────────────────────────────────────
const REPULSION = 8000;  // strength of node-node repulsion
const SPRING    = 0.05;  // spring constant for edge attraction
const REST_LEN  = 160;   // natural (resting) edge length in px
const DAMPING   = 0.85;  // velocity multiplier per frame (< 1 = slows down)
const GRAVITY   = 0.015; // pull toward canvas center
const TIME_STEP = 0.5;   // simulation step size per frame

// ── Visual constants ──────────────────────────────────────────
const NODE_RADIUS    = 26;
const COL_DEFAULT    = "#4f46e5"; // indigo  — regular nodes
const COL_TARGET     = "#f59e0b"; // amber   — start / end words
const COL_WIN        = "#10b981"; // emerald — nodes on winning path
const COL_EDGE       = "#94a3b8"; // slate   — regular edges
const COL_EDGE_WIN   = "#10b981"; // emerald — edges on winning path
const COL_TEXT       = "#ffffff";
const COL_BG         = "#0f172a"; // dark navy canvas background

// ============================================================
// Renderer
// Owns the animation loop and all drawing logic.
// graph property is set externally (by game.js) so the renderer
// always draws whatever is in the current graph.
// ============================================================
export class Renderer {
    constructor(canvas, graph) {
        this.canvas      = canvas;
        this.ctx         = canvas.getContext("2d");
        this.graph       = graph;   // Graph instance from graph.js

        this.startWord   = null;    // highlighted with amber ring
        this.endWord     = null;
        this.winningPath = null;    // string[] set by setWinningPath()

        this._running    = false;
        this._animFrame  = null;
        this._dragging   = null;    // GraphNode currently being dragged

        this._bindMouse();
    }

    // ----------------------------------------------------------
    // start / stop
    // Control the requestAnimationFrame loop.
    // ----------------------------------------------------------
    start() {
        if (this._running) return;
        this._running = true;
        this._loop();
    }

    stop() {
        this._running = false;
        if (this._animFrame) cancelAnimationFrame(this._animFrame);
    }

    // ----------------------------------------------------------
    // setStartEnd
    // Tell the renderer which two words to draw with amber rings.
    // ----------------------------------------------------------
    setStartEnd(startWord, endWord) {
        this.startWord = startWord?.toLowerCase() ?? null;
        this.endWord   = endWord?.toLowerCase()   ?? null;
    }

    // ----------------------------------------------------------
    // setWinningPath
    // Pass the array returned by graph.getPath() to light up
    // the solution in green.
    // ----------------------------------------------------------
    setWinningPath(path) {
        this.winningPath = path ? path.map(w => w.toLowerCase()) : null;
    }

    // ----------------------------------------------------------
    // _loop
    // One iteration: simulate physics then draw.
    // ----------------------------------------------------------
    _loop() {
        if (!this._running) return;
        this._simulate();
        this._draw();
        this._animFrame = requestAnimationFrame(() => this._loop());
    }

    // ----------------------------------------------------------
    // _simulate
    // Applies repulsion, spring, gravity, and damping forces
    // to every node for one time step.
    // ----------------------------------------------------------
    _simulate() {
        const nodes = Array.from(this.graph.nodes.values());
        const cx    = this.canvas.width  / 2;
        const cy    = this.canvas.height / 2;

        // ── 1. Repulsion: every pair pushes apart ──
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a  = nodes[i];
                const b  = nodes[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                // Add small epsilon to avoid division-by-zero when nodes overlap
                const dist  = Math.sqrt(dx * dx + dy * dy) + 0.01;
                const force = REPULSION / (dist * dist);
                const fx    = (dx / dist) * force * TIME_STEP;
                const fy    = (dy / dist) * force * TIME_STEP;

                // Equal and opposite forces
                a.vx -= fx;  a.vy -= fy;
                b.vx += fx;  b.vy += fy;
            }
        }

        // ── 2. Spring: edges pull nodes toward REST_LEN ──
        // We iterate every node's neighbor list. Because each edge
        // is stored on both sides, we apply half the force per side
        // so the net effect per edge is the full spring force.
        for (const node of nodes) {
            for (const neighborWord of node.neighbors) {
                const neighbor = this.graph.nodes.get(neighborWord);
                if (!neighbor) continue;

                const dx           = neighbor.x - node.x;
                const dy           = neighbor.y - node.y;
                const dist         = Math.sqrt(dx * dx + dy * dy) + 0.01;
                const displacement = dist - REST_LEN;

                // Multiply by 0.5 because this same edge is processed
                // again when we iterate from the neighbor's side.
                const fx = (dx / dist) * SPRING * displacement * 0.5 * TIME_STEP;
                const fy = (dy / dist) * SPRING * displacement * 0.5 * TIME_STEP;

                node.vx += fx;
                node.vy += fy;
            }
        }

        // ── 3. Gravity + damping + position update ──
        for (const node of nodes) {
            if (node === this._dragging) continue; // user is dragging this node

            // Gentle pull toward the center of the canvas
            node.vx += (cx - node.x) * GRAVITY * TIME_STEP;
            node.vy += (cy - node.y) * GRAVITY * TIME_STEP;

            // Dampen velocity so the graph settles instead of oscillating
            node.vx *= DAMPING;
            node.vy *= DAMPING;

            // Move the node
            node.x += node.vx;
            node.y += node.vy;

            // Clamp to canvas bounds
            const margin = NODE_RADIUS + 10;
            node.x = Math.max(margin, Math.min(this.canvas.width  - margin, node.x));
            node.y = Math.max(margin, Math.min(this.canvas.height - margin, node.y));
        }
    }

    // ----------------------------------------------------------
    // _draw
    // Clears the canvas and redraws every edge and node.
    // ----------------------------------------------------------
    _draw() {
        const ctx     = this.ctx;
        const winSet  = new Set(this.winningPath ?? []);

        // Clear background
        ctx.fillStyle = COL_BG;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // ── Draw edges ──
        for (const node of this.graph.nodes.values()) {
            for (const neighborWord of node.neighbors) {
                // Skip one direction so each edge is drawn exactly once
                if (node.word > neighborWord) continue;

                const neighbor   = this.graph.nodes.get(neighborWord);
                if (!neighbor) continue;

                const onWinPath  = winSet.has(node.word) && winSet.has(neighborWord);

                ctx.beginPath();
                ctx.moveTo(node.x, node.y);
                ctx.lineTo(neighbor.x, neighbor.y);
                ctx.strokeStyle = onWinPath ? COL_EDGE_WIN : COL_EDGE;
                ctx.lineWidth   = onWinPath ? 3 : 1.5;
                ctx.stroke();
            }
        }

        // ── Draw nodes ──
        for (const node of this.graph.nodes.values()) {
            const isTarget  = node.word === this.startWord || node.word === this.endWord;
            const isWinNode = winSet.has(node.word);

            // Fill color priority: winning path > target word > default
            ctx.beginPath();
            ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = isWinNode ? COL_WIN
                          : isTarget  ? COL_TARGET
                          :             COL_DEFAULT;
            ctx.fill();

            // Extra ring around the two target words
            if (isTarget) {
                ctx.strokeStyle = COL_TARGET;
                ctx.lineWidth   = 3;
                ctx.stroke();
            }

            // Word label centered inside the circle
            ctx.fillStyle    = COL_TEXT;
            ctx.font         = "bold 12px sans-serif";
            ctx.textAlign    = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(node.word, node.x, node.y);
        }
    }

    // ----------------------------------------------------------
    // _bindMouse
    // Lets the user click and drag nodes to rearrange the graph.
    // ----------------------------------------------------------
    _bindMouse() {
        // Convert a MouseEvent to canvas-local coordinates,
        // accounting for CSS scaling of the canvas element.
        const toCanvasPos = (e) => {
            const r  = this.canvas.getBoundingClientRect();
            return {
                x: (e.clientX - r.left) * (this.canvas.width  / r.width),
                y: (e.clientY - r.top)  * (this.canvas.height / r.height)
            };
        };

        // Return the node under the cursor, or null
        const hitTest = (pos) => {
            for (const node of this.graph.nodes.values()) {
                const dx = node.x - pos.x;
                const dy = node.y - pos.y;
                if (dx * dx + dy * dy <= NODE_RADIUS * NODE_RADIUS) return node;
            }
            return null;
        };

        this.canvas.addEventListener("mousedown", (e) => {
            this._dragging = hitTest(toCanvasPos(e));
        });

        this.canvas.addEventListener("mousemove", (e) => {
            if (!this._dragging) return;
            const pos        = toCanvasPos(e);
            this._dragging.x  = pos.x;
            this._dragging.y  = pos.y;
            this._dragging.vx = 0; // zero out velocity while dragging
            this._dragging.vy = 0;
        });

        // Release drag on mouseup or when cursor leaves the canvas
        this.canvas.addEventListener("mouseup",    () => { this._dragging = null; });
        this.canvas.addEventListener("mouseleave", () => { this._dragging = null; });
    }
}