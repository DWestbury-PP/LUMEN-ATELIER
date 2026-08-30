import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import GalleryTile from "../components/GalleryTile";
import { api } from "../lib/api";
import type { Piece, StudioStatus, TagCount } from "../lib/types";

// How many tag chips to show before the rest fold away.
const CHIP_LIMIT = 16;

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
  const [tags, setTags] = useState<TagCount[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [allChips, setAllChips] = useState(false);

  // The finder lives in the URL — a filtered wall is a shareable link and
  // the back button undoes a search.
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const filtering = q.trim() !== "" || tag !== "";
  const [draft, setDraft] = useState(q);
  useEffect(() => { setDraft(q); }, [q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (draft.trim() === q.trim()) return;
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (draft.trim()) next.set("q", draft.trim()); else next.delete("q");
        return next;
      }, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [draft, q, setParams]);
  const setTag = (t: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (t && t !== tag) next.set("tag", t); else next.delete("tag");
    return next;
  });
  const clearAll = () => { setDraft(""); setParams(new URLSearchParams()); };

  useEffect(() => {
    let alive = true;
    api.pieces("approved", { q, tag })
      .then((rows) => { if (!alive) return; setPieces(rows); if (!filtering) setTotal(rows.length); })
      .catch(() => { if (alive) setPieces([]); });
    return () => { alive = false; };
  }, [q, tag, filtering]);

  useEffect(() => {
    api.tags().then(setTags).catch(() => {});
    const tick = () => api.status().then(setStatus).catch(() => {});
    tick();
    const iv = setInterval(tick, 8000);
    return () => clearInterval(iv);
  }, []);

  const chips = allChips ? tags : tags.slice(0, CHIP_LIMIT);
  const hiddenActive = tag && !chips.some((c) => c.tag === tag);

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

      <div className="finder">
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Find a piece — a title, a mood, a colour…"
          aria-label="Search the collection"
          autoComplete="off"
        />
        {tags.length > 0 && (
          <div className="chips">
            {chips.map((c) => (
              <button
                key={c.tag}
                className={`chip${c.tag === tag ? " active" : ""}`}
                onClick={() => setTag(c.tag)}
                title={`${c.count} piece${c.count === 1 ? "" : "s"}`}
              >{c.tag}</button>
            ))}
            {hiddenActive && <button className="chip active" onClick={() => setTag(tag)}>{tag}</button>}
            {tags.length > CHIP_LIMIT && (
              <button className="chip more" onClick={() => setAllChips((v) => !v)}>
                {allChips ? "fewer" : `+${tags.length - CHIP_LIMIT} more`}
              </button>
            )}
          </div>
        )}
        {filtering && pieces !== null && (
          <div className="finder-status">
            {pieces.length === 0 ? "Nothing on the wall matches" : `${pieces.length}${total ? ` of ${total}` : ""} piece${pieces.length === 1 ? "" : "s"}`}
            {" · "}<button className="linklike" onClick={clearAll}>show everything</button>
          </div>
        )}
      </div>

      {pieces === null ? (
        <div className="empty">Lighting the gallery…</div>
      ) : pieces.length === 0 && !filtering ? (
        <div className="empty">
          The gallery is empty. <button className="linklike" onClick={onCommission}>Commission the first piece.</button>
        </div>
      ) : pieces.length === 0 ? (
        <div className="empty">No piece answers to that — try a different word, or <button className="linklike" onClick={clearAll}>show everything</button>.</div>
      ) : (
        <div className="grid">
          {pieces.map((p) => (
            <Link to={`/piece/${p.id}`} className="card" key={p.id}>
              <GalleryTile piece={p} />
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
