import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import ShaderCanvas from "../gl/ShaderCanvas";
import { api } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import type { PieceDetail } from "../lib/types";

export default function PiecePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [piece, setPiece] = useState<PieceDetail | null>(null);
  const [viewGlsl, setViewGlsl] = useState<string | null>(null);
  const [viewingDraft, setViewingDraft] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [curatorBusy, setCuratorBusy] = useState(false);
  const [curatorMsg, setCuratorMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    api.piece(id).then((p) => {
      setPiece(p);
      setViewGlsl(p.glsl ?? p.iterationRows.at(-1)?.glsl ?? null);
    }).catch(() => {});
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const isAdmin = user?.role === "admin";
  const isTerminal = piece && ["approved", "declined", "error", "rejected"].includes(piece.status);

  async function reiterate() {
    if (!piece) return;
    setCuratorBusy(true);
    setCuratorMsg(null);
    const res = await fetch(`/api/admin/pieces/${piece.id}/reiterate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    });
    setCuratorBusy(false);
    if (res.ok) {
      setCuratorMsg("Sent back to the studio — the ensemble will resume shortly. Watch the studio floor.");
      setNote("");
      load();
    } else {
      const b = await res.json().catch(() => ({}));
      setCuratorMsg(b.error || "That didn't work.");
    }
  }

  async function forkPiece() {
    if (!piece) return;
    setCuratorBusy(true);
    setCuratorMsg(null);
    const res = await fetch(`/api/admin/pieces/${piece.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    });
    setCuratorBusy(false);
    if (res.ok) {
      const fork = await res.json();
      navigate(`/piece/${fork.id}`);
      setNote("");
      setCuratorMsg(null);
    } else {
      const b = await res.json().catch(() => ({}));
      setCuratorMsg(b.error || "That didn't work.");
    }
  }

  async function deletePiece() {
    if (!piece) return;
    const label = piece.title ?? `piece #${piece.id}`;
    if (!window.confirm(`Delete “${label}” permanently? Its drafts, critiques, and history all go with it. This cannot be undone.`)) return;
    const res = await fetch(`/api/admin/pieces/${piece.id}`, { method: "DELETE" });
    if (res.ok) navigate("/");
    else {
      const b = await res.json().catch(() => ({}));
      setCuratorMsg(b.error || "Could not delete.");
    }
  }

  async function hangDraft(idx: number) {
    if (!piece) return;
    const res = await fetch(`/api/admin/pieces/${piece.id}/hang-draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idx }),
    });
    if (res.ok) load();
  }

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
          {viewGlsl && <ShaderCanvas glsl={viewGlsl} maxDpr={1.5} fpsCap={60} />}
        </div>
        <div className="stage-caption">
          {viewingDraft !== null ? (
            <>
              <span>Viewing draft {viewingDraft + 1} — an earlier state of this piece</span>
              <button className="linklike" onClick={() => { setViewGlsl(piece.glsl); setViewingDraft(null); }}>
                return to final
              </button>
            </>
          ) : (
            <>
              <span />
              {piece.glsl && (
                <Link className="linklike" to={`/exhibit?start=${piece.id}`}>
                  ⛶ view in the exhibit
                </Link>
              )}
            </>
          )}
        </div>
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

          {isAdmin && isTerminal && (
            <div className="curator-box">
              <h3>Curator's prerogative</h3>
              <p>
                Send this piece back to the studio for further iteration. Your direction
                outranks the Critic's notes; the Artisan resumes from the latest draft.
              </p>
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional direction, e.g. 'the palette drifts too warm — hold the original blues'"
                maxLength={1000}
              />
              <div className="row" style={{ justifyContent: "flex-start", marginTop: 12, flexWrap: "wrap", gap: 10 }}>
                <button className="btn solid" onClick={reiterate} disabled={curatorBusy}
                  title="Re-queue THIS piece for more drafts under your direction">
                  {curatorBusy ? "Working…" : "Send back to the studio"}
                </button>
                <button className="btn" onClick={forkPiece} disabled={curatorBusy}
                  title="Create a NEW piece that starts from this one's final draft — this piece stays untouched">
                  Fork &amp; redraft
                </button>
                <button className="btn danger" onClick={deletePiece} disabled={curatorBusy}
                  title="Permanently delete this piece and its history">
                  Delete
                </button>
              </div>
              {curatorMsg && <p className="fine-warn" style={{ marginTop: 10 }}>{curatorMsg}</p>}
            </div>
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
              {piece.inspiration && piece.inspiration.length > 0 && (
                <div>
                  <dt>Patron's inspiration</dt>
                  <dd>
                    <div className="inspo-row">
                      {piece.inspiration.map((img, i) => (
                        <a key={i} href={img} target="_blank" rel="noreferrer" className="inspo-thumb view">
                          <img src={img} alt={`inspiration ${i + 1}`} />
                        </a>
                      ))}
                    </div>
                  </dd>
                </div>
              )}
              {piece.ledger && (
                <div>
                  <dt>Studio ledger</dt>
                  <dd>
                    {(piece.ledger.input_tokens + piece.ledger.output_tokens).toLocaleString()} tokens
                    {" · "}{piece.ledger.calls} model calls
                    {" · "}~${piece.ledger.cost_usd.toFixed(2)}
                  </dd>
                </div>
              )}
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
                {it.critique && (
                  <span className={`verdict-label ${it.critique.verdict}`}>
                    critic&thinsp;—&thinsp;{it.critique.verdict}
                  </span>
                )}
                {it.compile_ok === false && <span className="verdict-label decline">render failed</span>}
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
                {isAdmin && it.compile_ok && piece.glsl !== it.glsl && (
                  <button className="linklike" style={{ marginLeft: 20 }} onClick={() => hangDraft(it.idx)}>
                    ▸ hang this draft (curator override)
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}
