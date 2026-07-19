// Live WebGL2 renderer for atelier pieces. Every artwork is pure math —
// shaders ship as text and render in real time on the visitor's GPU.
//
// Hardened for a gallery of UNVETTED, machine-written shaders:
//  - a context exists only while the canvas is on-screen (browsers cap ~16
//    live WebGL contexts; exceeding it silently kills the oldest)
//  - shader compilation is ASYNC where the driver allows it
//    (KHR_parallel_shader_compile): querying link status on a fresh
//    machine-written shader forces a synchronous GL→Metal/HLSL translation
//    that can stall the browser's GPU process for seconds — the "whole
//    browser blanks" failure. We poll completion instead of blocking on it.
//  - webglcontextlost is caught and the canvas self-restores after a beat
//  - a frame-time watchdog pauses pathologically heavy shaders before they
//    can stall the GPU long enough to blank the whole browser
//  - thumbnails are FPS-capped; only hero views run at full rate

import { useEffect, useMemo, useRef, useState } from "react";

const VS =
  "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";

// Watchdog: this many consecutive slow frames triggers a pause.
const SLOW_FRAME_MS = 350;
const SLOW_FRAME_LIMIT = 4;

// Audition pass: every shader must render one frame at postage-stamp size
// within this budget before it's allowed on screen at full resolution. A
// shader that needs >150ms for ~5k pixels would need seconds for a full
// frame — enough to stall the GPU and blank the entire browser.
const PROBE_W = 96;
const PROBE_H = 54;
const PROBE_LIMIT_MS = 150;

// A shader that kills its context this many times is retired from live
// rendering (auto-respawning a lethal shader re-kills the GPU in a loop).
const MAX_CONTEXT_LOSSES = 2;

// Hard budget of concurrent live contexts, page-wide. WebKit's cap is far
// lower than Chrome's, and letting the browser evict "the oldest context"
// during a scroll counts as a loss against whatever innocent shader owned
// it — two evictions and it's wrongly retired. Stay under every cap and
// queue the rest; a waiting tile takes the next freed slot.
const MAX_LIVE_CONTEXTS = 6;
let liveContexts = 0;
const contextWaiters = new Set<() => void>();
function releaseContextSlot() {
  liveContexts--;
  const next = contextWaiters.values().next();
  if (!next.done) {
    contextWaiters.delete(next.value);
    next.value();
  }
}

// Losses that arrive in a cluster are systemic — the browser shedding
// contexts under pressure (it counts not-yet-collected dead ones too) —
// and prove nothing about any one shader. Only a lone loss is a strike.
let lastContextLossAt = 0;
const LOSS_CLUSTER_MS = 1500;

// Only tiles that stay in view this long get a context; flicking past a
// row of pieces shouldn't create (and then orphan) a context per tile.
const VISIBLE_DEBOUNCE_MS = 250;

interface Props {
  glsl: string;
  /** Device-pixel-ratio cap; keep low for grid thumbnails, higher for hero views. */
  maxDpr?: number;
  /** Frame-rate cap. 30 is plenty for thumbnails; 60 for hero/exhibit. */
  fpsCap?: number;
  /** Pause rendering (e.g. exhibit layer that's faded out). */
  paused?: boolean;
  /** Fires once per shader: true when it passed audition and is drawing,
   *  false if it failed (compile error, too heavy, no context). Lets a
   *  parent double-buffer — keep the old piece up until the new one is live. */
  onSettled?: (ok: boolean) => void;
  className?: string;
}

export default function ShaderCanvas({ glsl, maxDpr = 1, fpsCap = 30, paused = false, onSettled, className }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [generation, setGeneration] = useState(0); // bump to force a fresh canvas + context
  const [status, setStatus] = useState<"ok" | "error" | "heavy">("ok");
  // Desynchronize instances so a grid of pieces doesn't pulse in lockstep.
  const timeOffset = useMemo(() => Math.random() * 90, []);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const lossCount = useRef(0);

  // Watch visibility of the wrapper (not the canvas — the canvas may not exist yet).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let timer = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        clearTimeout(timer);
        if (entry.isIntersecting) {
          timer = window.setTimeout(() => setVisible(true), VISIBLE_DEBOUNCE_MS);
        } else {
          setVisible(false);
        }
      },
      { rootMargin: "120px" }
    );
    io.observe(el);
    return () => { clearTimeout(timer); io.disconnect(); };
  }, []);

  // New shader source: clear any previous error/heavy verdict.
  useEffect(() => {
    lossCount.current = 0;
    setStatus("ok");
    setGeneration((g) => g + 1);
  }, [glsl]);

  useEffect(() => {
    if (!visible || status !== "ok") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let settledHere = false;
    const settle = (ok: boolean) => {
      if (settledHere) return;
      settledHere = true;
      onSettledRef.current?.(ok);
    };

    // Wait for a context slot rather than blowing the browser's cap.
    if (liveContexts >= MAX_LIVE_CONTEXTS) {
      const wake = () => setGeneration((g) => g + 1);
      contextWaiters.add(wake);
      return () => { contextWaiters.delete(wake); };
    }
    liveContexts++;
    let slotHeld = true;
    const releaseOnce = () => {
      if (!slotHeld) return;
      slotHeld = false;
      releaseContextSlot();
    };

    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) { releaseOnce(); setStatus("error"); settle(false); return; }

    const onLost = (e: Event) => {
      e.preventDefault();
      if (disposed) return;
      const now = performance.now();
      const clustered = now - lastContextLossAt < LOSS_CLUSTER_MS;
      lastContextLossAt = now;
      if (clustered) {
        // Eviction storm, not this shader's crime: respawn, no strike.
        setTimeout(() => setGeneration((g) => g + 1), 1500);
        return;
      }
      lossCount.current += 1;
      if (lossCount.current >= MAX_CONTEXT_LOSSES) {
        // This shader keeps taking the GPU down — retire it. A human can
        // still opt in via the overlay, but we never auto-retry a killer.
        setStatus("heavy");
        settle(false);
      } else {
        setTimeout(() => setGeneration((g) => g + 1), 1500);
      }
    };
    canvas.addEventListener("webglcontextlost", onLost);

    // Compile + link WITHOUT querying status — status queries force the
    // driver to finish translating the shader synchronously, freezing the
    // GPU process on big machine-written sources.
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

    let raf = 0;
    let ro: ResizeObserver | null = null;

    let droppedGl = false;
    const dropGl = () => {
      if (droppedGl) return;
      droppedGl = true;
      canvas.removeEventListener("webglcontextlost", onLost);
      if (!gl.isContextLost()) {
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    };

    const finishSetup = () => {
      if (disposed) return;
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        dropGl();
        setStatus("error");
        settle(false);
        return;
      }
      gl.useProgram(prog);
      const uRes = gl.getUniformLocation(prog, "iResolution");
      const uTime = gl.getUniformLocation(prog, "iTime");

      // ── Audition pass ── one tiny synchronous frame, timed. Shaders that
      // blow the budget here would stall the GPU at full resolution.
      canvas.width = PROBE_W;
      canvas.height = PROBE_H;
      gl.viewport(0, 0, PROBE_W, PROBE_H);
      if (uRes) gl.uniform2f(uRes, PROBE_W, PROBE_H);
      if (uTime) gl.uniform1f(uTime, 0.8 + timeOffset);
      const probeStart = performance.now();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      if (performance.now() - probeStart > PROBE_LIMIT_MS) {
        dropGl();
        setStatus("heavy");
        settle(false);
        return;
      }

      let lastDraw = 0;
      let lastTick = 0;
      let slowStreak = 0;
      const minFrameGap = 1000 / Math.max(1, fpsCap);
      const start = performance.now();
      const dpr = () => Math.min(window.devicePixelRatio || 1, maxDpr);

      function resize() {
        const c = canvasRef.current;
        if (!c) return;
        const w = Math.max(1, Math.round(c.clientWidth * dpr()));
        const h = Math.max(1, Math.round(c.clientHeight * dpr()));
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      }

      function frame(now: number) {
        if (disposed) return;
        raf = requestAnimationFrame(frame);
        if (pausedRef.current || document.hidden) { lastTick = now; return; }

        // Watchdog: if rAF gaps stretch while we're actively drawing, the GPU is
        // being strangled by this shader — stop before the compositor gives up.
        // Monster gaps are NOT the shader's doing: a GPU-strangling shader
        // produces a steady drumbeat of ~0.4-1s frames, while a multi-second
        // gap means the main thread stalled elsewhere (an SSE burst landing,
        // a heavy re-render, a background tab waking). Don't convict for those.
        if (lastTick > 0) {
          const gap = now - lastTick;
          if (gap > SLOW_FRAME_MS * 7) {
            slowStreak = 0;
          } else if (gap > SLOW_FRAME_MS) {
            slowStreak++;
            if (slowStreak >= SLOW_FRAME_LIMIT) { setStatus("heavy"); return; }
          } else if (gap < SLOW_FRAME_MS / 2) {
            slowStreak = 0;
          }
        }
        lastTick = now;

        if (now - lastDraw < minFrameGap) return; // fps cap
        lastDraw = now;

        resize();
        const c = canvasRef.current!;
        gl!.viewport(0, 0, c.width, c.height);
        if (uRes) gl!.uniform2f(uRes, c.width, c.height);
        if (uTime) gl!.uniform1f(uTime, (now - start) / 1000 + timeOffset);
        gl!.drawArrays(gl!.TRIANGLES, 0, 3);
      }

      ro = new ResizeObserver(() => resize());
      ro.observe(canvas);
      resize();
      raf = requestAnimationFrame(frame);
      settle(true);
    };

    // Prefer async compilation: poll the driver instead of blocking the GPU
    // process. Falls back to the classic synchronous path where unsupported.
    const par = gl.getExtension("KHR_parallel_shader_compile");
    if (par) {
      const poll = () => {
        if (disposed) return;
        if (gl.getProgramParameter(prog, par.COMPLETION_STATUS_KHR)) finishSetup();
        else raf = requestAnimationFrame(poll);
      };
      raf = requestAnimationFrame(poll);
    } else {
      finishSetup();
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      dropGl();
      releaseOnce();
    };
  }, [glsl, visible, generation, status, maxDpr, fpsCap, timeOffset]);

  return (
    <div ref={wrapRef} className={`glwrap ${className ?? ""}`}>
      {visible && status === "ok" && <canvas key={generation} ref={canvasRef} />}
      {status === "error" && <div className="gl-error">this piece could not be rendered</div>}
      {status === "heavy" && (
        <button
          className="gl-heavy"
          onClick={() => { lossCount.current = 0; setStatus("ok"); setGeneration((g) => g + 1); }}
          title="This shader is too demanding for live rendering; click to try anyway"
        >
          paused — heavy piece · click to attempt
        </button>
      )}
    </div>
  );
}
