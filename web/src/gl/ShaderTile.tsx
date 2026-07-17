// A gallery tile fronting the shared TilePainter. The tile's own <canvas>
// holds only an ImageBitmapRenderingContext — the shared painter draws the
// frame and transfers the pixels in. A tile that scrolls out of range simply
// stops receiving frames and keeps its last one frozen, so scrolling back
// never pops. Browsers without OffscreenCanvas get the classic per-tile
// ShaderCanvas instead.

import { useEffect, useRef, useState } from "react";
import ShaderCanvas from "./ShaderCanvas";
import { tilePainter, tilePainterSupported, type TileHandle, type TileStatus } from "./tilePainter";

// Pre-warm margin: tiles within ~a row above/below the viewport compile and
// draw before they arrive, so entry is seamless.
const WARM_MARGIN = "50% 0px";

const SUPPORTED = tilePainterSupported();

export default function ShaderTile({ glsl }: { glsl: string }) {
  if (!SUPPORTED) return <ShaderCanvas glsl={glsl} maxDpr={1} />;
  return <PaintedTile glsl={glsl} />;
}

function PaintedTile({ glsl }: { glsl: string }) {
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
    if (!handle) return;
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

  return (
    <div ref={wrapRef} className="glwrap">
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
