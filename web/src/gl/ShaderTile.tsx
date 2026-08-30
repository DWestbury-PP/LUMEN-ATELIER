// A gallery tile fronting the shared TilePainter. The tile's own <canvas>
// holds only an ImageBitmapRenderingContext — the shared painter draws the
// frame and transfers the pixels in. A tile that scrolls out of range simply
// stops receiving frames and keeps its last one frozen, so scrolling back
// never pops. Browsers that can't host the painter — no OffscreenCanvas, or
// a WebKit whose OffscreenCanvas can't do WebGL — get the classic per-tile
// ShaderCanvas instead, decided up front by the capability probe and again
// at runtime if context creation fails anyway.

import { useEffect, useRef, useState } from "react";
import ShaderCanvas from "./ShaderCanvas";
import { tilePainter, tilePainterSupported, type TileHandle, type TileStatus } from "./tilePainter";

// Pre-warm margin: tiles within ~a row above/below the viewport compile and
// draw before they arrive, so entry is seamless.
const WARM_MARGIN = "50% 0px";

const SUPPORTED = tilePainterSupported();

interface Props {
  glsl: string;
  /** False = paint one frame and hold it as a still (default true). */
  animate?: boolean;
  /** Transparent background so a poster underneath shows until the first frame lands. */
  overlay?: boolean;
}

export default function ShaderTile({ glsl, animate = true, overlay = false }: Props) {
  if (!SUPPORTED) return <ShaderCanvas glsl={glsl} maxDpr={1} className={overlay ? "glwrap--overlay" : undefined} />;
  return <PaintedTile glsl={glsl} animate={animate} overlay={overlay} />;
}

function PaintedTile({ glsl, animate, overlay }: Required<Props>) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<TileHandle | null>(null);
  const [status, setStatus] = useState<TileStatus>("compiling");

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const handle = tilePainter.register(canvas, glsl, setStatus);
    handleRef.current = handle;
    if (!handle) {
      setStatus("unsupported");
      return;
    }
    handle.setAnimate(animate);
    const io = new IntersectionObserver(
      ([entry]) => handle.setVisible(entry.isIntersecting),
      { rootMargin: WARM_MARGIN }
    );
    io.observe(wrap);
    return () => {
      io.disconnect();
      handle.dispose();
      handleRef.current = null;
    };
  }, [glsl]);

  useEffect(() => { handleRef.current?.setAnimate(animate); }, [animate]);

  if (status === "unsupported") return <ShaderCanvas glsl={glsl} maxDpr={1} className={overlay ? "glwrap--overlay" : undefined} />;

  return (
    <div ref={wrapRef} className={`glwrap${overlay ? " glwrap--overlay" : ""}`}>
      <canvas ref={canvasRef} />
      {status === "error" && <div className="gl-error">this piece could not be rendered</div>}
      {status === "heavy" && (
        <button
          className="gl-heavy"
          onClick={() => handleRef.current?.retry()}
          title="This shader is too demanding for live rendering; click to try anyway"
        >
          paused — heavy piece · click to attempt
        </button>
      )}
    </div>
  );
}
