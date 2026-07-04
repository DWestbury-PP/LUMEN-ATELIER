// Exhibition mode: fullscreen, ambient, pieces cross-fading on a slow cycle.
// Made to run on a spare monitor and make people stop walking.
//
// GPU discipline: exactly ONE live shader context, except during the
// crossfade window when the outgoing piece briefly overlaps — then its
// canvas (and GL context) is unmounted entirely. Fullscreen machine-written
// shaders at unbounded resolution can grind a GPU to reset; this keeps the
// exhibit exhilarating without taking the compositor down with it.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import ShaderCanvas from "../gl/ShaderCanvas";
import { api } from "../lib/api";
import type { Piece } from "../lib/types";

const DWELL_MS = 45_000;
const FADE_MS = 2_600;

export default function Exhibit() {
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [idx, setIdx] = useState(0);
  const [outgoing, setOutgoing] = useState<number | null>(null);
  const idxRef = useRef(0);
  const countRef = useRef(0);
  const fadeTimer = useRef<number | null>(null);

  useEffect(() => {
    api.pieces().then((all) => {
      const withArt = all.filter((p) => p.glsl);
      setPieces(withArt);
      countRef.current = withArt.length;
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (pieces.length < 2) return;
    const iv = setInterval(() => advance(), DWELL_MS);
    return () => {
      clearInterval(iv);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieces.length]);

  function advance() {
    if (countRef.current < 2) return;
    setOutgoing(idxRef.current);
    idxRef.current = (idxRef.current + 1) % countRef.current;
    setIdx(idxRef.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    // Once the fade completes, drop the outgoing canvas — and its GL context.
    fadeTimer.current = window.setTimeout(() => setOutgoing(null), FADE_MS + 300);
  }

  if (pieces.length === 0) {
    return (
      <div className="exhibit">
        <div className="gl-error" style={{ height: "100%" }}>the gallery is empty</div>
        <Link to="/" className="exit">← leave the exhibit</Link>
      </div>
    );
  }

  const current = pieces[idx];
  const previous = outgoing !== null ? pieces[outgoing] : null;

  return (
    <div className="exhibit" onClick={advance} title="click to advance">
      {previous?.glsl && (
        <div className="layer out" key={`out-${outgoing}`}>
          <ShaderCanvas glsl={previous.glsl} maxDpr={1.5} fpsCap={60} />
        </div>
      )}
      <div className="layer in" key={`in-${idx}`}>
        {current?.glsl && <ShaderCanvas glsl={current.glsl} maxDpr={1.5} fpsCap={60} />}
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
