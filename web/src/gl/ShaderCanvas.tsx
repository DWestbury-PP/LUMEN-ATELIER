// Live WebGL2 renderer for atelier pieces. Every artwork is pure math —
// shaders ship as text and render in real time on the visitor's GPU.

import { useEffect, useMemo, useRef, useState } from "react";

const VS =
  "#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";

interface Props {
  glsl: string;
  /** Device-pixel-ratio cap; lower for grid thumbnails, higher for hero views. */
  maxDpr?: number;
  /** Pause rendering (e.g. exhibit layer that's faded out). */
  paused?: boolean;
  className?: string;
}

export default function ShaderCanvas({ glsl, maxDpr = 1.25, paused = false, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Desynchronize instances so a grid of pieces doesn't pulse in lockstep.
  const timeOffset = useMemo(() => Math.random() * 90, []);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setError(null);

    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "high-performance" });
    if (!gl) {
      setError("WebGL2 unavailable");
      return;
    }

    function compile(type: number, src: string): WebGLShader | string {
      const sh = gl!.createShader(type)!;
      gl!.shaderSource(sh, src);
      gl!.compileShader(sh);
      if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
        const log = gl!.getShaderInfoLog(sh) || "compile failed";
        gl!.deleteShader(sh);
        return log;
      }
      return sh;
    }

    const vs = compile(gl.VERTEX_SHADER, VS);
    const fs = compile(gl.FRAGMENT_SHADER, glsl);
    if (typeof vs === "string" || typeof fs === "string") {
      setError("shader failed to compile");
      return;
    }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      setError("shader failed to link");
      return;
    }
    gl.useProgram(prog);
    const uRes = gl.getUniformLocation(prog, "iResolution");
    const uTime = gl.getUniformLocation(prog, "iTime");

    let raf = 0;
    let visible = true;
    let disposed = false;
    const start = performance.now();

    const dpr = () => Math.min(window.devicePixelRatio || 1, maxDpr);

    function resize() {
      const c = canvasRef.current;
      if (!c) return;
      const w = Math.max(1, Math.round(c.clientWidth * dpr()));
      const h = Math.max(1, Math.round(c.clientHeight * dpr()));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }

    function frame(now: number) {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      if (!visible || pausedRef.current) return;
      resize();
      const c = canvasRef.current!;
      gl!.viewport(0, 0, c.width, c.height);
      if (uRes) gl!.uniform2f(uRes, c.width, c.height);
      if (uTime) gl!.uniform1f(uTime, (now - start) / 1000 + timeOffset);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    }

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    io.observe(canvas);

    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);

    resize();
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [glsl, maxDpr, timeOffset]);

  if (error) return <div className="gl-error">{error}</div>;
  return <canvas ref={canvasRef} className={className} />;
}
