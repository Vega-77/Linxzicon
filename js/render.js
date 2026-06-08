// ============================================================
// render.js — with debug logging to diagnose invisible nodes
// ============================================================

const REPULSION = 50000;
const SPRING    = 0.06;
const REST_LEN  = 200;
const DAMPING   = 0.85;
const GRAVITY   = 0.008;
const TIME_STEP = 0.5;

const NODE_RADIUS  = 30;
const COL_DEFAULT  = "#4f46e5";
const COL_TARGET   = "#f59e0b";
const COL_WIN      = "#10b981";
const COL_EDGE     = "#475569";
const COL_EDGE_WIN = "#10b981";
const COL_TEXT     = "#ffffff";
const COL_BG       = "#0f172a";

const PIN_START_X = 0.15;
const PIN_END_X   = 0.85;
const PIN_Y       = 0.5;

export class Renderer {
    constructor(canvas, graph) {
        this.canvas      = canvas;
        this.ctx         = canvas.getContext("2d");
        this.graph       = graph;
        this.startWord   = null;
        this.endWord     = null;
        this.winningPath = null;
        this.hideLabels  = false;
        this._running    = false;
        this._animFrame  = null;
        this._dragging   = null;
        this._frameCount = 0;

        this._bindMouse();
        console.log("[Renderer] constructed, canvas:", canvas.width, "x", canvas.height);
    }

    start() {
        if (this._running) return;
        this._running = true;

        // ── Critical: canvas must have non-zero pixel dimensions ──
        // The CSS may size it but the attribute width/height must match.
        // If width/height are 0 nothing will ever draw.
        if (this.canvas.width === 0 || this.canvas.height === 0) {
            this.canvas.width  = this.canvas.offsetWidth  || 900;
            this.canvas.height = this.canvas.offsetHeight || 520;
            console.warn("[Renderer] canvas had 0 dimensions, forced to",
                this.canvas.width, "x", this.canvas.height);
        }

        console.log("[Renderer] start(), canvas:", this.canvas.width, "x", this.canvas.height,
            "nodes:", this.graph.nodes.size);
        this._loop();
    }

    stop() {
        this._running = false;
        if (this._animFrame) cancelAnimationFrame(this._animFrame);
    }

    setStartEnd(startWord, endWord) {
        this.startWord = startWord?.toLowerCase() ?? null;
        this.endWord   = endWord?.toLowerCase()   ?? null;
        console.log("[Renderer] setStartEnd:", this.startWord, "→", this.endWord);
        this._pinNodes();
    }

    _pinNodes() {
        const w = this.canvas.width  || this.canvas.offsetWidth  || 900;
        const h = this.canvas.height || this.canvas.offsetHeight || 520;

        const sNode = this.startWord && this.graph.nodes.get(this.startWord);
        if (sNode) {
            sNode.x = w * PIN_START_X;
            sNode.y = h * PIN_Y;
            sNode.vx = sNode.vy = 0;
            sNode.pinned = true;
        }
        const eNode = this.endWord && this.graph.nodes.get(this.endWord);
        if (eNode) {
            eNode.x = w * PIN_END_X;
            eNode.y = h * PIN_Y;
            eNode.vx = eNode.vy = 0;
            eNode.pinned = true;
        }
    }

    setWinningPath(path) {
        this.winningPath = path ? path.map(w => w.toLowerCase()) : null;
    }

    _loop() {
        if (!this._running) return;

        // Re-sync canvas dimensions every frame in case the element was resized
        const cw = this.canvas.offsetWidth;
        const ch = this.canvas.offsetHeight;
        if (cw > 0 && ch > 0 &&
            (this.canvas.width !== cw || this.canvas.height !== ch)) {
            this.canvas.width  = cw;
            this.canvas.height = ch;
        }

        this._pinNodes();
        this._simulate();
        this._draw();

        this._frameCount++;
        // Log first 3 frames so we know the loop is running
        if (this._frameCount <= 3) {
            const nodes = Array.from(this.graph.nodes.values());
            console.log(`[Renderer] frame ${this._frameCount}`,
                "canvas:", this.canvas.width, "x", this.canvas.height,
                "nodes:", nodes.length,
                nodes.map(n => `${n.word}(${Math.round(n.x)},${Math.round(n.y)})`).join(" "));
        }

        this._animFrame = requestAnimationFrame(() => this._loop());
    }

    _simulate() {
        const nodes = Array.from(this.graph.nodes.values());
        const cx    = this.canvas.width  / 2;
        const cy    = this.canvas.height / 2;

        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a = nodes[i], b = nodes[j];
                const dx = b.x - a.x, dy = b.y - a.y;
                const dist  = Math.sqrt(dx*dx + dy*dy) + 0.01;
                const force = REPULSION / (dist * dist);
                const fx = (dx/dist)*force*TIME_STEP;
                const fy = (dy/dist)*force*TIME_STEP;
                if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
                if (!b.pinned) { b.vx += fx; b.vy += fy; }
            }
        }

        for (const node of nodes) {
            for (const nw of node.neighbors) {
                const nb = this.graph.nodes.get(nw);
                if (!nb) continue;
                const dx = nb.x-node.x, dy = nb.y-node.y;
                const dist = Math.sqrt(dx*dx+dy*dy)+0.01;
                const disp = dist - REST_LEN;
                const fx = (dx/dist)*SPRING*disp*0.5*TIME_STEP;
                const fy = (dy/dist)*SPRING*disp*0.5*TIME_STEP;
                if (!node.pinned) { node.vx += fx; node.vy += fy; }
            }
        }

        for (const node of nodes) {
            if (node.pinned || node === this._dragging) continue;
            node.vx += (cx - node.x) * GRAVITY * TIME_STEP;
            node.vy += (cy - node.y) * GRAVITY * TIME_STEP;
            node.vx *= DAMPING;
            node.vy *= DAMPING;
            node.x  += node.vx;
            node.y  += node.vy;
            const m = NODE_RADIUS + 10;
            node.x = Math.max(m, Math.min(this.canvas.width  - m, node.x));
            node.y = Math.max(m, Math.min(this.canvas.height - m, node.y));
        }
    }

    _draw() {
        const ctx    = this.ctx;
        const W      = this.canvas.width;
        const H      = this.canvas.height;
        const winSet = new Set(this.winningPath ?? []);

        ctx.fillStyle = COL_BG;
        ctx.fillRect(0, 0, W, H);

        // Edges
        for (const node of this.graph.nodes.values()) {
            for (const nw of node.neighbors) {
                if (node.word > nw) continue;
                const nb = this.graph.nodes.get(nw);
                if (!nb) continue;
                const onWin = winSet.has(node.word) && winSet.has(nw);
                ctx.beginPath();
                ctx.moveTo(node.x, node.y);
                ctx.lineTo(nb.x, nb.y);
                ctx.strokeStyle = onWin ? COL_EDGE_WIN : COL_EDGE;
                ctx.lineWidth   = onWin ? 4 : 1.5;
                ctx.stroke();
            }
        }

        // Nodes
        for (const node of this.graph.nodes.values()) {
            const isTarget  = node.word === this.startWord || node.word === this.endWord;
            const isWinNode = winSet.has(node.word);

            if (isTarget) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, NODE_RADIUS + 7, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(245,158,11,0.15)";
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = isWinNode ? COL_WIN : isTarget ? COL_TARGET : COL_DEFAULT;
            ctx.fill();

            if (isTarget || isWinNode) {
                ctx.strokeStyle = isWinNode ? COL_WIN : COL_TARGET;
                ctx.lineWidth   = 3;
                ctx.stroke();
            }

            const label = (this.hideLabels &&
                           node.word !== this.startWord &&
                           node.word !== this.endWord)
                ? "?" : node.word;
            ctx.fillStyle    = COL_TEXT;
            ctx.font         = `bold ${label.length > 8 ? 10 : 12}px sans-serif`;
            ctx.textAlign    = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, node.x, node.y);

            if (isTarget) {
                ctx.fillStyle  = "rgba(245,158,11,0.8)";
                ctx.font       = "9px sans-serif";
                ctx.fillText(
                    node.word === this.startWord ? "START" : "END",
                    node.x, node.y + NODE_RADIUS + 11
                );
            }
        }
    }

    _bindMouse() {
        const toPos = (e) => {
            const r = this.canvas.getBoundingClientRect();
            return {
                x: (e.clientX - r.left) * (this.canvas.width  / r.width),
                y: (e.clientY - r.top)  * (this.canvas.height / r.height)
            };
        };
        const hit = (pos) => {
            for (const n of this.graph.nodes.values()) {
                if (n.pinned) continue;
                const dx = n.x - pos.x, dy = n.y - pos.y;
                if (dx*dx + dy*dy <= NODE_RADIUS*NODE_RADIUS) return n;
            }
            return null;
        };
        this.canvas.addEventListener("mousedown",  (e) => { this._dragging = hit(toPos(e)); });
        this.canvas.addEventListener("mousemove",  (e) => {
            if (!this._dragging) return;
            const p = toPos(e);
            this._dragging.x = p.x; this._dragging.y = p.y;
            this._dragging.vx = this._dragging.vy = 0;
        });
        this.canvas.addEventListener("mouseup",    () => { this._dragging = null; });
        this.canvas.addEventListener("mouseleave", () => { this._dragging = null; });
    }
}