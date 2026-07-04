// Exhibition mode: fullscreen, ambient — but the visitor holds the reins.
// Arrows / keyboard step forward and back through the collection; the
// auto-advance timer re-arms after every manual step. Deep-linkable:
// /exhibit?start=<pieceId> opens on a chosen piece.
//
// GPU discipline: exactly ONE live shader context, except during the
// crossfade window when the outgoing piece briefly overlaps — then its
// canvas (and GL context) is unmounted entirely.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
  const fadeTimer = useRef<number | null>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();

  useEffect(() => {
    api.pieces().then((all) => {
      // Shuffle the rotation so pieces from the same creative era (which can
      // share a family resemblance) don't hang side by side; a deep-linked
      // start piece leads the walk.
      const withArt = all.filter((p) => p.glsl);
      for (let i = withArt.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [withArt[i], withArt[j]] = [withArt[j], withArt[i]];
      }
      const startId = Number(params.get("start"));
      const startAt = withArt.findIndex((p) => p.id === startId);
      if (startAt > 0) {
        const [chosen] = withArt.splice(startAt, 1);
        withArt.unshift(chosen);
      }
      idxRef.current = 0;
      setIdx(0);
      setPieces(withArt);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = useCallback((delta: number) => {
    const n = pieces.length;
    if (n < 2) return;
    setOutgoing(idxRef.current);
    idxRef.current = (idxRef.current + delta + n) % n;
    setIdx(idxRef.current);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    // Once the fade completes, drop the outgoing canvas — and its GL context.
    fadeTimer.current = window.setTimeout(() => setOutgoing(null), FADE_MS + 300);
  }, [pieces.length]);

  // Auto-advance re-arms on every step (manual or automatic).
  useEffect(() => {
    if (pieces.length < 2) return;
    const t = setTimeout(() => step(1), DWELL_MS);
    return () => clearTimeout(t);
  }, [idx, pieces.length, step]);

  useEffect(() => () => { if (fadeTimer.current) clearTimeout(fadeTimer.current); }, []);

  // Keyboard: ← → step, Escape leaves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "Escape") navigate("/");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, navigate]);

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
    <div className="exhibit" onClick={() => step(1)} title="click to advance · arrow keys to browse">
      {previous?.glsl && (
        <div className="layer out" key={`out-${outgoing}-${idx}`}>
          <ShaderCanvas glsl={previous.glsl} maxDpr={1.5} fpsCap={60} />
        </div>
      )}
      <div className="layer in" key={`in-${idx}`}>
        {current?.glsl && <ShaderCanvas glsl={current.glsl} maxDpr={1.5} fpsCap={60} />}
      </div>

      {pieces.length > 1 && (
        <>
          <button
            className="nav-arrow prev"
            aria-label="previous piece"
            onClick={(e) => { e.stopPropagation(); step(-1); }}
          >‹</button>
          <button
            className="nav-arrow next"
            aria-label="next piece"
            onClick={(e) => { e.stopPropagation(); step(1); }}
          >›</button>
        </>
      )}

      <div className="caption">
        {current.title ?? "Untitled"}
        <small>
          Lumen Atelier {current.seed ? "— calibration piece" : current.patron ? `— for ${current.patron}` : "— studio original"}
        </small>
      </div>
      <div className="counter">{idx + 1} / {pieces.length}</div>
      <Link to="/" className="exit" onClick={(e) => e.stopPropagation()}>← leave the exhibit</Link>
    </div>
  );
}
