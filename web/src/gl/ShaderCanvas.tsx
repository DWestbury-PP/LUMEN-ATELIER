// Live WebGL2 renderer for atelier pieces. Every artwork is pure math —
// shaders ship as text and render in real time on the visitor's GPU.
//
// Hardened for a gallery of UNVETTED, machine-written shaders:
//  - a context exists only while the canvas is on-screen (browsers cap ~16
//    live WebGL contexts; exceeding it silently kills the oldest)
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

interface Props {
  glsl: string;
  /** Device-pixel-ratio cap; keep low for grid thumbnails, higher for hero views. */
  maxDpr?: number;
  /** Frame-rate cap. 30 is plenty for thumbnails; 60 for hero/exhibit. */
  fpsCap?: number;
  /** Pause rendering (e.g. exhibit layer that's faded out). */
  paused?: boolean;
  className?: string;
}

export default function ShaderCanvas({ glsl, maxDpr = 1, fpsCap = 30, paused = false, className }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [generation, setGeneration] = useState(0); // bump to force a fresh canvas + context
  const [status, setStatus] = useState<"ok" | "error" | "heavy">("ok");
  // Desynchronize instances so a grid of pieces doesn't pulse in lockstep.
  const timeOffset = useMemo(() => Math.random() * 90, []);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Watch visibility of the wrapper (not the canvas — the canvas may not exist yet).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "120px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // New shader source: clear any previous error/heavy verdict.
  useEffect(() => {
    setStatus("ok");
    setGeneration((g) => g + 1);
  }, [glsl]);

  useEffect(() => {
    if (!visible || status !== "ok") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
    if (!gl) { setStatus("error"); return; }

    let disposed = false;

    const onLost = (e: Event) => {
      e.preventDefault();
      // GPU reset or context eviction — retire this canvas and respawn shortly.
      if (!disposed) setTimeout(() => setGeneration((g) => g + 1), 1200);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    function compile(type: number, src: string): WebGLShader | null {
      const sh = gl!.createShader(type)!;
      gl!.shaderSource(sh, src);
      gl!.compileShader(sh);
      if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
        gl!.deleteShader(sh);
        return null;
      }
      return sh;
    }

    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, glsl);
    if (!vs || !fs) {
      canvas.removeEventListener("webglcontextlost", onLost);
      setStatus("error");
      return;
    }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      canvas.removeEventListener("webglcontextlost", onLost);
      setStatus("error");
      return;
    }
    gl.useProgram(prog);
    const uRes = gl.getUniformLocation(prog, "iResolution");
    const uTime = gl.getUniformLocation(prog, "iTime");

    let raf = 0;
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
      if (lastTick > 0) {
        const gap = now - lastTick;
        if (gap > SLOW_FRAME_MS) {
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

    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);
    resize();
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      if (!gl.isContextLost()) {
        gl.deleteProgram(prog);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [glsl, visible, generation, status, maxDpr, fpsCap, timeOffset]);

  return (
    <div ref={wrapRef} className={`glwrap ${className ?? ""}`}>
      {visible && status === "ok" && <canvas key={generation} ref={canvasRef} />}
      {status === "error" && <div className="gl-error">this piece could not be rendered</div>}
      {status === "heavy" && (
        <button
          className="gl-heavy"
          onClick={() => { setStatus("ok"); setGeneration((g) => g + 1); }}
          title="This shader was pausing your GPU; click to try again"
        >
          paused — heavy piece · click to resume
        </button>
      )}
    </div>
  );
}
