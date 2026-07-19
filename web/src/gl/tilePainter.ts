// The gallery's shared painter: ONE WebGL context renders every tile.
//
// Per-tile contexts don't survive a large collection — browsers cap live
// WebGL contexts (WebKit even counts dead-but-uncollected ones), and
// scrolling churns through create/compile/destroy on every pass, which
// janks the main thread and gets innocent shaders convicted as "heavy."
// Instead, a single hidden canvas draws each visible tile's frame and the
// pixels are handed to the tile's own <canvas>, which never holds a WebGL
// context of its own.
//
// Two backends, chosen by capability:
//  - "bitmap": OffscreenCanvas + transferToImageBitmap into the tile's
//    ImageBitmapRenderingContext. Near-free GPU-side transfer on Chrome.
//  - "blit": a hidden regular <canvas> + 2D drawImage into the tile.
//    For WebKits whose OffscreenCanvas can't host WebGL (Safari < 17) —
//    a copy, but ONE context total, so WebKit's context cap and its
//    eviction storms simply cannot occur.
//
//  - each shader compiles ONCE per session, async where the driver allows,
//    at most two in flight so a scroll burst can't stampede the GPU
//  - only visible tiles are drawn; a tile that scrolls away keeps its last
//    frame frozen on its own canvas, so returning to it never pops
//  - heaviness is judged per shader by measurement — an audition at compile
//    time plus a rotating spot-check — never by ambient scroll jank
//  - if the shared context dies, the shader on the easel at that moment is
//    blamed; two kills and it's retired. Everyone else recompiles quietly
//    behind their frozen frames.
//
// THE GOVERNOR. On WebKit the frame hand-off is a real copy, and older
// GPUs can't run a whole wall at 30fps — push anyway and WebKit kills the
// tab's GPU process: the page goes black. So the painter measures its own
// per-tick cost and steps down a quality ladder: lower fps, lower render
// scale, and fewer tiles animating (nearest the viewport center first).
// Every visible tile still gets ONE real frame and holds it as a still —
// degraded is a quieter wall, never a blank one. Sustained calm slowly
// climbs back up.

const VS =
  "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";

const MAX_CONCURRENT_COMPILES = 2;

// Quality ladder. `animate` caps how many tiles run live (rest hold stills).
const LEVELS = [
  { fps: 30, scale: 1, animate: Infinity },
  { fps: 24, scale: 0.75, animate: 8 },
  { fps: 15, scale: 0.6, animate: 4 },
  { fps: 10, scale: 0.5, animate: 2 },
] as const;
// Main-thread ms per tick (EMA) that triggers a step down; calm below
// RELAX_MS for RELAX_AFTER_MS earns a step back up.
const BUSY_STEP_MS = 8;
const RELAX_MS = 3;
const RELAX_AFTER_MS = 25_000;
const RANK_INTERVAL_MS = 400;

// Audition: one tiny timed frame before a shader is allowed on the wall.
const PROBE_W = 96;
const PROBE_H = 54;
const PROBE_LIMIT_MS = 150;

// Spot-check: every couple of seconds, time one visible tile's full draw.
const POLICE_INTERVAL_MS = 2000;
const POLICE_LIMIT_MS = 120;

// Without KHR_parallel_shader_compile every compile stalls the main thread,
// so take them one at a time with breathing room between.
const SYNC_COMPILE_GAP_MS = 300;

const MAX_KILLS = 2;

export type TileStatus = "compiling" | "ready" | "error" | "heavy" | "unsupported";
export type PainterMode = "bitmap" | "blit";

interface ProgramEntry {
  prog: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  uRes: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  status: TileStatus;
}

interface Tile {
  glsl: string;
  el: HTMLCanvasElement;
  out: ImageBitmapRenderingContext | CanvasRenderingContext2D;
  visible: boolean;
  lastDraw: number;
  timeOffset: number;
  lastStatus: TileStatus | null;
  onStatus: (s: TileStatus) => void;
  /** Nearness order to viewport center; only the top `animate` keep moving. */
  rank: number;
  /** Has at least one real frame on its canvas (may be frozen). */
  hasFrame: boolean;
}

export interface TileHandle {
  setVisible(v: boolean): void;
  retry(): void;
  dispose(): void;
}

function detectMode(): PainterMode | null {
  // OffscreenCanvas existing is NOT enough — WebKit shipped it long before
  // it could host a WebGL context (Safari 17), and a null context would
  // strand every tile black. Probe what it can actually DO.
  try {
    if (typeof OffscreenCanvas !== "undefined" && document.createElement("canvas").getContext("bitmaprenderer")) {
      const gl = new OffscreenCanvas(4, 4).getContext("webgl2");
      if (gl) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return "bitmap";
      }
    }
  } catch { /* fall through to blit probe */ }
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (gl) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return "blit";
    }
  } catch { /* no webgl2 at all */ }
  return null;
}

const MODE: PainterMode | null = typeof document !== "undefined" ? detectMode() : null;

export function tilePainterSupported(): boolean {
  return MODE !== null;
}

class TilePainter {
  private surface: OffscreenCanvas | HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private parExt: { COMPLETION_STATUS_KHR: number } | null = null;
  private entries = new Map<string, ProgramEntry>();
  private compiling = new Set<string>();
  private tiles = new Set<Tile>();
  private raf = 0;
  private rebuilding = false;
  private lastPolice = 0;
  private lastDrawnKey: string | null = null;
  private kills = new Map<string, number>();
  private retired = new Set<string>(); // killed the context too often
  private level = 0;
  private busyEma = 0;
  private calmSince = 0;
  private lastRank = 0;
  private lastCompileDone = 0;
  /** Context creation failed outright — this browser can't run the painter.
   *  Tiles are told "unsupported" so they can fall back to per-tile canvases. */
  private dead = false;

  register(el: HTMLCanvasElement, glsl: string, onStatus: (s: TileStatus) => void): TileHandle | null {
    if (this.dead || MODE === null) return null;
    const out = MODE === "bitmap" ? el.getContext("bitmaprenderer") : el.getContext("2d");
    if (!out) return null;
    const tile: Tile = {
      glsl, el, out,
      visible: false,
      lastDraw: 0,
      // Desynchronize tiles so the wall doesn't pulse in lockstep.
      timeOffset: Math.random() * 90,
      lastStatus: null,
      onStatus,
      rank: Infinity,
      hasFrame: false,
    };
    this.tiles.add(tile);
    this.start();
    return {
      setVisible: (v) => { tile.visible = v; if (v) this.start(); },
      retry: () => this.retry(glsl),
      dispose: () => { this.tiles.delete(tile); },
    };
  }

  private retry(glsl: string) {
    this.retired.delete(glsl);
    this.kills.delete(glsl);
    const e = this.entries.get(glsl);
    // An audition-flagged program is compiled and linked — just let it draw
    // again (the spot-check can re-convict). A retired one recompiles fresh.
    if (e && e.status === "heavy") e.status = "ready";
    this.start();
  }

  private start() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private ensureGl(): WebGL2RenderingContext | null {
    if (this.gl && !this.gl.isContextLost()) return this.gl;
    if (this.rebuilding) return null;
    if (this.gl) {
      // Context died mid-frame: blame whoever was on the easel.
      const culprit = this.lastDrawnKey;
      if (culprit) {
        const n = (this.kills.get(culprit) ?? 0) + 1;
        this.kills.set(culprit, n);
        if (n >= MAX_KILLS) this.retired.add(culprit);
      }
      this.gl = null;
      this.surface = null;
      this.entries.clear();
      this.compiling.clear();
      // A dead context is also the loudest overload signal there is.
      if (this.level < LEVELS.length - 1) this.level++;
      this.rebuilding = true;
      setTimeout(() => { this.rebuilding = false; this.start(); }, 1500);
      return null;
    }
    const surface = MODE === "bitmap"
      ? new OffscreenCanvas(PROBE_W, PROBE_H)
      : document.createElement("canvas");
    if (surface instanceof HTMLCanvasElement) {
      surface.width = PROBE_W;
      surface.height = PROBE_H;
    }
    const gl = surface.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" }) as WebGL2RenderingContext | null;
    if (!gl) {
      this.dead = true;
      return null;
    }
    surface.addEventListener("webglcontextlost", (e: Event) => e.preventDefault());
    this.parExt = gl.getExtension("KHR_parallel_shader_compile");
    this.surface = surface;
    this.gl = gl;
    return gl;
  }

  private entryFor(gl: WebGL2RenderingContext, glsl: string): ProgramEntry {
    let e = this.entries.get(glsl);
    if (e) return e;
    const mk = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, VS);
    const fs = mk(gl.FRAGMENT_SHADER, glsl);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    e = { prog, vs, fs, uRes: null, uTime: null, status: "compiling" };
    this.entries.set(glsl, e);
    this.compiling.add(glsl);
    return e;
  }

  /** May this tile start a compile right now? Async drivers take a pair at a
   *  time; sync drivers take exactly one, spaced out, and only for tiles
   *  close enough to matter at the current quality level. */
  private mayCompile(tile: Tile, now: number): boolean {
    if (this.parExt) return this.compiling.size < MAX_CONCURRENT_COMPILES;
    if (this.compiling.size > 0) return false;
    if (now - this.lastCompileDone < SYNC_COMPILE_GAP_MS) return false;
    const cap = LEVELS[this.level].animate;
    return tile.rank < (Number.isFinite(cap) ? (cap as number) + 2 : Infinity);
  }

  // Never query link status before the driver says compilation is complete —
  // that forces a synchronous GL→native translation that can stall the
  // browser's whole GPU process on big machine-written shaders.
  private pumpCompiles(gl: WebGL2RenderingContext, now: number) {
    for (const key of [...this.compiling]) {
      const e = this.entries.get(key)!;
      const done = this.parExt
        ? gl.getProgramParameter(e.prog, this.parExt.COMPLETION_STATUS_KHR)
        : true;
      if (!done) continue;
      this.compiling.delete(key);
      this.finalize(gl, key, e);
      this.lastCompileDone = now;
    }
  }

  private finalize(gl: WebGL2RenderingContext, key: string, e: ProgramEntry) {
    if (!gl.getProgramParameter(e.prog, gl.LINK_STATUS)) {
      e.status = "error";
      return;
    }
    gl.useProgram(e.prog);
    e.uRes = gl.getUniformLocation(e.prog, "iResolution");
    e.uTime = gl.getUniformLocation(e.prog, "iTime");
    // Audition: a shader that needs >150ms for ~5k pixels would need seconds
    // for a full tile — flag it before it can stall the shared context.
    gl.viewport(0, 0, PROBE_W, PROBE_H);
    if (e.uRes) gl.uniform2f(e.uRes, PROBE_W, PROBE_H);
    if (e.uTime) gl.uniform1f(e.uTime, 0.8);
    this.lastDrawnKey = key;
    const t0 = performance.now();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();
    e.status = performance.now() - t0 > PROBE_LIMIT_MS ? "heavy" : "ready";
  }

  /** Order visible tiles by distance to viewport center; the closest keep
   *  animating when the governor tightens. Reads layout, so throttled. */
  private rankTiles(now: number) {
    if (now - this.lastRank < RANK_INTERVAL_MS) return;
    this.lastRank = now;
    const mid = window.innerHeight / 2;
    const near: { tile: Tile; d: number }[] = [];
    for (const tile of this.tiles) {
      if (!tile.visible) { tile.rank = Infinity; continue; }
      const r = tile.el.getBoundingClientRect();
      if (r.width === 0) { tile.rank = Infinity; continue; }
      near.push({ tile, d: Math.abs((r.top + r.bottom) / 2 - mid) });
    }
    near.sort((a, b) => a.d - b.d);
    near.forEach((x, i) => { x.tile.rank = i; });
  }

  private govern(busy: number, now: number) {
    this.busyEma = this.busyEma * 0.9 + busy * 0.1;
    if (this.busyEma > BUSY_STEP_MS && this.level < LEVELS.length - 1) {
      this.level++;
      this.busyEma = 0;
      this.calmSince = now;
    } else if (this.busyEma > RELAX_MS) {
      this.calmSince = now;
    } else if (this.level > 0 && now - this.calmSince > RELAX_AFTER_MS) {
      this.level--;
      this.calmSince = now;
    }
  }

  /** Hand the surface's freshly drawn frame to the tile. */
  private deliver(tile: Tile, w: number, h: number) {
    if (MODE === "bitmap") {
      (tile.out as ImageBitmapRenderingContext).transferFromImageBitmap(
        (this.surface as OffscreenCanvas).transferToImageBitmap()
      );
    } else {
      // Same-task drawImage of a WebGL canvas is guaranteed to see the
      // frame even without preserveDrawingBuffer.
      if (tile.el.width !== w) tile.el.width = w;
      if (tile.el.height !== h) tile.el.height = h;
      (tile.out as CanvasRenderingContext2D).drawImage(
        this.surface as HTMLCanvasElement, 0, 0, w, h, 0, 0, w, h
      );
    }
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.tiles.size === 0) return;
    if (this.dead) {
      // No context, ever. Hand every tile to its fallback and stop ticking.
      for (const tile of this.tiles) {
        if (tile.lastStatus !== "unsupported") {
          tile.lastStatus = "unsupported";
          tile.onStatus("unsupported");
        }
      }
      return;
    }
    this.raf = requestAnimationFrame(this.tick);
    if (document.hidden) return;

    const t0 = performance.now();
    // If this trips `dead`, the already-queued next tick broadcasts it.
    const gl = this.ensureGl();
    if (!gl) return;
    const surface = this.surface!;
    const q = LEVELS[this.level];
    const minFrameGap = 1000 / q.fps;

    this.rankTiles(now);

    // Start compiles for shaders whose tiles are near the viewport.
    for (const tile of this.tiles) {
      if (!tile.visible) continue;
      if (this.retired.has(tile.glsl)) continue;
      if (!this.entries.has(tile.glsl) && this.mayCompile(tile, now)) {
        this.entryFor(gl, tile.glsl);
      }
    }
    this.pumpCompiles(gl, now);

    const police = now - this.lastPolice > POLICE_INTERVAL_MS;
    let policed = false;
    // Under pressure, at most one first-paint per tick — a freshly scrolled-to
    // row fills in over a few frames instead of stalling one.
    let firstPaints = 0;

    for (const tile of this.tiles) {
      // Keep each tile's overlay honest even while it's off-screen.
      const status: TileStatus = this.retired.has(tile.glsl)
        ? "heavy"
        : this.entries.get(tile.glsl)?.status ?? "compiling";
      if (status !== tile.lastStatus) {
        tile.lastStatus = status;
        tile.onStatus(status);
      }
      if (!tile.visible || status !== "ready") continue;
      if (now - tile.lastDraw < minFrameGap) continue;
      if (tile.hasFrame) {
        if (tile.rank >= q.animate) continue; // holds its still
      } else if (this.level > 0 && firstPaints >= 1) {
        continue;
      }

      const e = this.entries.get(tile.glsl)!;
      const dpr = Math.min(window.devicePixelRatio || 1, 1);
      if (tile.el.clientWidth === 0) continue; // not laid out yet
      const w = Math.max(1, Math.round(tile.el.clientWidth * dpr * q.scale));
      const h = Math.max(1, Math.round(tile.el.clientHeight * dpr * q.scale));
      if (surface.width !== w) surface.width = w;
      if (surface.height !== h) surface.height = h;

      gl.useProgram(e.prog);
      gl.viewport(0, 0, w, h);
      if (e.uRes) gl.uniform2f(e.uRes, w, h);
      if (e.uTime) gl.uniform1f(e.uTime, now / 1000 + tile.timeOffset);
      this.lastDrawnKey = tile.glsl;
      const t1 = performance.now();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // Spot-check the first tile drawn this frame: measure ITS cost with a
      // sync finish. Convictions here are individual, not ambient.
      if (police && !policed) {
        policed = true;
        this.lastPolice = now;
        gl.finish();
        if (performance.now() - t1 > POLICE_LIMIT_MS) {
          e.status = "heavy";
          continue;
        }
      }
      if (gl.isContextLost()) return; // blame lands next tick
      tile.lastDraw = now;
      if (!tile.hasFrame) { tile.hasFrame = true; firstPaints++; }
      this.deliver(tile, w, h);
    }

    this.govern(performance.now() - t0, now);
  };
}

export const tilePainter = new TilePainter();
