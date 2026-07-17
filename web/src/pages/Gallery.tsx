import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import ShaderTile from "../gl/ShaderTile";
import { api } from "../lib/api";
import type { Piece, StudioStatus } from "../lib/types";

const PHASE_COPY: Record<string, string> = {
  idle: "The studio is quiet.",
  brief: "The Muse is writing a brief…",
  drafting: "The Artisan is writing a shader…",
  rendering: "The studio is rendering frames…",
  critique: "The Critic is examining the work…",
  finalizing: "Titling and framing an approved piece…",
};

export default function Gallery({ onCommission }: { onCommission: () => void }) {
  const [pieces, setPieces] = useState<Piece[] | null>(null);
  const [status, setStatus] = useState<StudioStatus | null>(null);

  useEffect(() => {
    api.pieces().then(setPieces).catch(() => setPieces([]));
    const tick = () => api.status().then(setStatus).catch(() => {});
    tick();
    const iv = setInterval(tick, 8000);
    return () => clearInterval(iv);
  }, []);

  const working = status && status.phase !== "idle" && status.hasKey;

  return (
    <>
      <section className="hero">
        <h1>An atelier where the artist can see its own work.</h1>
        <p>
          Three Claude models run this studio: the Muse writes a concept brief, the Artisan
          writes a real-time GLSL shader, and the Critic <em>looks</em> at the rendered
          frames — approving, or sending the work back with notes — until the piece earns
          its place here.
        </p>
        <p className="fine">
          Everything below is a live shader, rendering right now on your GPU.
        </p>
      </section>

      <div className="ribbon">
        <span className={`dot ${working ? "live" : "asleep"}`} />
        {status === null
          ? "Reaching the studio…"
          : !status.hasKey
            ? "The ensemble is asleep (no API key configured). The gallery remains open."
            : PHASE_COPY[status.phase] ?? status.phase}
        {status && status.queueLength > 0 && <span>· {status.queueLength} commission{status.queueLength > 1 ? "s" : ""} in the book</span>}
        <Link to="/studio">Watch the studio floor →</Link>
      </div>

      <div className="section-label">The Collection</div>

      {pieces === null ? (
        <div className="empty">Lighting the gallery…</div>
      ) : pieces.length === 0 ? (
        <div className="empty">
          The gallery is empty. <button className="linklike" onClick={onCommission}>Commission the first piece.</button>
        </div>
      ) : (
        <div className="grid">
          {pieces.map((p) => (
            <Link to={`/piece/${p.id}`} className="card" key={p.id}>
              <div className="frame">
                {p.glsl && <ShaderTile glsl={p.glsl} />}
              </div>
              <div className="meta">
                <span className="title">{p.title ?? "Untitled"}</span>
                <span className="sub">
                  {p.seed ? "calibration" : p.patron ? `for ${p.patron}` : "studio original"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
