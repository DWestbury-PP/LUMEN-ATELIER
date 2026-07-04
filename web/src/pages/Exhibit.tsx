// Exhibition mode: fullscreen, ambient, pieces cross-fading on a slow cycle.
// Made to run on a spare monitor and make people stop walking.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import ShaderCanvas from "../gl/ShaderCanvas";
import { api } from "../lib/api";
import type { Piece } from "../lib/types";

const DWELL_MS = 45_000;

export default function Exhibit() {
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [index, setIndex] = useState(0);
  const [frontIsA, setFrontIsA] = useState(true);
  const indexRef = useRef(0);

  useEffect(() => {
    api.pieces().then((all) => setPieces(all.filter((p) => p.glsl))).catch(() => {});
  }, []);

  useEffect(() => {
    if (pieces.length < 2) return;
    const iv = setInterval(() => advance(), DWELL_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieces.length]);

  function advance() {
    indexRef.current = (indexRef.current + 1) % pieces.length;
    setIndex(indexRef.current);
    setFrontIsA((v) => !v);
  }

  if (pieces.length === 0) {
    return (
      <div className="exhibit">
        <div className="gl-error" style={{ height: "100%" }}>the gallery is empty</div>
        <Link to="/" className="exit">← leave the exhibit</Link>
      </div>
    );
  }

  const current = pieces[index];
  const previous = pieces[(index - 1 + pieces.length) % pieces.length];
  // Two layers; the incoming piece renders on the front layer, the outgoing fades.
  const layerA = frontIsA ? current : previous;
  const layerB = frontIsA ? previous : current;

  return (
    <div className="exhibit" onClick={advance} title="click to advance">
      <div className="layer" style={{ opacity: frontIsA ? 1 : 0 }}>
        {layerA?.glsl && <ShaderCanvas glsl={layerA.glsl} maxDpr={2} paused={!frontIsA} />}
      </div>
      <div className="layer" style={{ opacity: frontIsA ? 0 : 1 }}>
        {layerB?.glsl && <ShaderCanvas glsl={layerB.glsl} maxDpr={2} paused={frontIsA} />}
      </div>
      <div className="caption">
        {current.title ?? "Untitled"}
        <small>
          Lumen Atelier {current.seed ? "— calibration piece" : current.patron ? `— for ${current.patron}` : "— studio original"}
        </small>
      </div>
      <Link to="/" className="exit" onClick={(e) => e.stopPropagation()}>← leave the exhibit</Link>
    </div>
  );
}
