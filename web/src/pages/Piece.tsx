import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import ShaderCanvas from "../gl/ShaderCanvas";
import { api } from "../lib/api";
import type { PieceDetail } from "../lib/types";

export default function PiecePage() {
  const { id } = useParams();
  const [piece, setPiece] = useState<PieceDetail | null>(null);
  const [viewGlsl, setViewGlsl] = useState<string | null>(null);
  const [viewingDraft, setViewingDraft] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;
    api.piece(id).then((p) => {
      setPiece(p);
      setViewGlsl(p.glsl ?? p.iterationRows.at(-1)?.glsl ?? null);
    }).catch(() => {});
  }, [id]);

  if (!piece) return <div className="empty">Fetching the piece…</div>;

  const brief = piece.brief;
  const showDraft = (idx: number, glsl: string) => {
    setViewGlsl(glsl);
    setViewingDraft(idx);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <>
      <div className="piece-hero">
        <div className="frame">
          {viewGlsl && <ShaderCanvas glsl={viewGlsl} maxDpr={2} />}
        </div>
        {viewingDraft !== null && (
          <div className="stage-caption">
            <span>Viewing draft {viewingDraft + 1} — an earlier state of this piece</span>
            <button className="linklike" onClick={() => { setViewGlsl(piece.glsl); setViewingDraft(null); }}>
              return to final
            </button>
          </div>
        )}
      </div>

      <div className="piece-info">
        <div>
          <h1>{piece.title ?? "Untitled"}</h1>
          {piece.status === "declined" && (
            <p className="statement" style={{ color: "var(--decline)" }}>
              The Critic declined this piece — it never entered the collection. Its process
              remains on record below.
            </p>
          )}
          {piece.statement && <p className="statement">{piece.statement}</p>}
          {piece.theme && (
            <p className="statement" style={{ fontSize: 13, marginTop: 14 }}>
              Commissioned{piece.patron ? ` by ${piece.patron}` : ""} on the theme: “{piece.theme}”
            </p>
          )}
        </div>

        {brief && (
          <aside className="brief-panel">
            <h3>The Muse's Brief</h3>
            <dl>
              <div><dt>Concept</dt><dd>{brief.concept}</dd></div>
              <div>
                <dt>Palette</dt>
                <dd>
                  <div className="swatches">
                    {(brief.palette ?? []).map((c, i) => (
                      <span key={i} className="swatch" style={{ background: c }} title={c} />
                    ))}
                  </div>
                </dd>
              </div>
              <div><dt>Reference</dt><dd>{brief.reference}</dd></div>
              <div><dt>Motion</dt><dd>{brief.motion}</dd></div>
              <div><dt>Mood</dt><dd>{brief.mood}</dd></div>
            </dl>
          </aside>
        )}
      </div>

      {piece.iterationRows.length > 0 && (
        <>
          <div className="section-label">The Creative Process</div>
          {piece.iterationRows.map((it) => (
            <div className="iteration" key={it.idx}>
              <header>
                <span className="idx">Draft {it.idx + 1}</span>
                {it.critique && <span className={`badge ${it.critique.verdict}`}>{it.critique.verdict}</span>}
                {it.compile_ok === false && <span className="badge decline">render failed</span>}
                {it.critique && (
                  <span className="scores">
                    <span>comp <b>{it.critique.scores.composition}</b></span>
                    <span>color <b>{it.critique.scores.color}</b></span>
                    <span>motion <b>{it.critique.scores.motion}</b></span>
                    <span>fidelity <b>{it.critique.scores.fidelity}</b></span>
                    <span>overall <b>{it.critique.scores.overall}</b></span>
                  </span>
                )}
              </header>
              {it.frames && (
                <div className="thumbs">
                  {it.frames.map((f, i) => <img key={i} src={f} alt={`draft ${it.idx + 1} frame ${i + 1}`} />)}
                </div>
              )}
              {it.artisan_notes && <p className="critique"><em>Artisan:</em> {it.artisan_notes}</p>}
              {it.critique && (
                <>
                  <p className="critique"><em>Critic:</em> {it.critique.critique}</p>
                  {it.critique.suggestions.length > 0 && (
                    <ul className="suggestions">
                      {it.critique.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  )}
                </>
              )}
              <div className="actions">
                <button className="linklike" onClick={() => showDraft(it.idx, it.glsl)}>
                  ▸ view this draft live
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
