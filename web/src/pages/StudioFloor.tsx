import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import ShaderCanvas from "../gl/ShaderCanvas";

interface FeedItem {
  key: string;
  who: "muse" | "artisan" | "critic" | "studio";
  label: string;
  text: string;
  frames?: string[];
  pieceId?: number | null;
  at?: string;
}

interface RawEvent {
  type: string;
  payload: Record<string, any>;
  pieceId?: number | null;
  piece_id?: number | null;
  at?: string;
  created_at?: string;
}

let keyCounter = 0;
function toFeedItem(ev: RawEvent): FeedItem | null {
  const p = ev.payload ?? {};
  const base = {
    key: `${ev.type}-${keyCounter++}`,
    pieceId: ev.pieceId ?? ev.piece_id ?? null,
    at: ev.at ?? ev.created_at,
  };
  switch (ev.type) {
    case "commission.received":
      return { ...base, who: "studio", label: "Commission", text: `“${p.theme}”${p.patron ? ` — from ${p.patron}` : ""}` };
    case "studio.self_commission":
      return { ...base, who: "studio", label: "Studio", text: "The ensemble sets itself a new piece — no commission, pure practice." };
    case "piece.started":
      return { ...base, who: "studio", label: "Studio", text: p.theme ? `Work begins on the commission: “${p.theme}”` : "Work begins on a self-directed piece." };
    case "muse.research":
      return { ...base, who: "muse", label: "The Muse", text: `Consulting the research wing on ${p.subject}…` };
    case "muse.brief": {
      const b = p.brief ?? {};
      return { ...base, who: "muse", label: "The Muse", text: `Brief — “${b.title_working}”: ${b.concept} (after ${b.reference})` };
    }
    case "artisan.started":
      return { ...base, who: "artisan", label: "The Artisan", text: `Begins draft ${(p.iteration ?? 0) + 1}.` };
    case "artisan.draft":
      return { ...base, who: "artisan", label: "The Artisan", text: p.notes || "A new draft is ready." };
    case "artisan.compile_error":
      return { ...base, who: "artisan", label: "The Artisan", text: `The shader failed to compile (attempt ${p.attempt}). Repairing…` };
    case "iteration.rendered":
      return { ...base, who: "studio", label: "Studio Eyes", text: `Draft ${(p.iteration ?? 0) + 1} rendered. Frames captured for the Critic:`, frames: p.frames as string[] };
    case "critic.verdict": {
      const v = p.verdict ?? {};
      const s = v.scores ?? {};
      return {
        ...base, who: "critic", label: `The Critic — ${String(v.verdict ?? "").toUpperCase()}`,
        text: `${v.critique ?? ""} (composition ${s.composition}, color ${s.color}, motion ${s.motion}, fidelity ${s.fidelity} — overall ${s.overall})`,
      };
    }
    case "piece.approved":
      return { ...base, who: "studio", label: "Studio", text: `ACCEPTED INTO THE COLLECTION — “${p.title}” after ${p.iterations} draft${p.iterations > 1 ? "s" : ""}.` };
    case "piece.declined":
      return { ...base, who: "studio", label: "Studio", text: `The Critic declined the piece after ${p.iterations} drafts. The studio moves on.` };
    case "piece.render_failed":
      return { ...base, who: "studio", label: "Studio", text: "Rendering failed for this draft; the studio abandons it and tries fresh." };
    case "studio.error":
      return { ...base, who: "studio", label: "Studio", text: `A disturbance in the studio: ${p.message}` };
    case "studio.no_key":
      return { ...base, who: "studio", label: "Studio", text: String(p.message ?? "The ensemble is asleep.") };
    default:
      return null;
  }
}

export default function StudioFloor() {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [currentGlsl, setCurrentGlsl] = useState<string | null>(null);
  const [delta, setDelta] = useState("");
  const [connected, setConnected] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const feedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");

    const push = (item: FeedItem | null) => {
      if (!item) return;
      setFeed((f) => [...f.slice(-120), item]);
    };

    const handle = (ev: RawEvent) => {
      if (ev.type === "artisan.delta") {
        setDelta((d) => (d + String(ev.payload?.text ?? "")).slice(-6000));
        setDrafting(true);
        return;
      }
      if (ev.type === "artisan.started") { setDelta(""); setDrafting(true); }
      if (ev.type === "artisan.draft" && ev.payload?.glsl) { setCurrentGlsl(String(ev.payload.glsl)); setDrafting(false); }
      if (ev.type === "iteration.rendered" && ev.payload?.glsl) setCurrentGlsl(String(ev.payload.glsl));
      if (ev.type === "piece.approved" || ev.type === "piece.declined") setDrafting(false);
      push(toFeedItem(ev));
    };

    es.addEventListener("hello", () => setConnected(true));
    es.addEventListener("history", (e) => {
      try {
        const rows = JSON.parse((e as MessageEvent).data) as RawEvent[];
        const items = rows.map(toFeedItem).filter(Boolean) as FeedItem[];
        setFeed(items.slice(-120));
        // Recover the most recent draft so the stage isn't empty on arrival.
        for (let i = rows.length - 1; i >= 0; i--) {
          const g = rows[i]?.payload?.glsl;
          if (g) { setCurrentGlsl(String(g)); break; }
        }
      } catch { /* ignore malformed history */ }
    });
    es.addEventListener("studio", (e) => {
      try { handle(JSON.parse((e as MessageEvent).data)); } catch { /* ignore */ }
    });
    es.onerror = () => setConnected(false);

    return () => es.close();
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [feed.length]);

  return (
    <>
      <section className="hero" style={{ padding: "44px 0 8px" }}>
        <h1>The studio floor, live.</h1>
        <p>
          Watch the ensemble at work — briefs written, shaders drafted token by token,
          frames captured, verdicts delivered. Nothing here is staged.
        </p>
      </section>

      <div className="floor">
        <div className="stage">
          <div className="frame">
            {currentGlsl
              ? <ShaderCanvas glsl={currentGlsl} maxDpr={1.25} fpsCap={30} />
              : <div className="gl-error">no work on the easel yet</div>}
          </div>
          <div className="stage-caption">
            <span>ON THE EASEL — current working draft, rendered live</span>
            <span>{connected ? "connected" : "reconnecting…"}</span>
          </div>
          {(drafting || delta) && (
            <div className="codepane">
              {delta || "the Artisan lifts the pen…"}
              {drafting && <span className="cursor" />}
            </div>
          )}
        </div>

        <div className="feed" ref={feedRef}>
          {feed.length === 0 && (
            <div className="empty" style={{ padding: "40px 0" }}>
              The floor is quiet. <Link to="/" style={{ color: "var(--gold)" }}>Browse the gallery</Link> or commission a piece.
            </div>
          )}
          {feed.map((item) => (
            <div className={`feed-item ${item.who}`} key={item.key}>
              <div className="who">
                {item.label}
                {item.at && <span className="when">{new Date(item.at).toLocaleTimeString()}</span>}
              </div>
              <div className="what">{item.text}</div>
              {item.frames && (
                <div className="frames-strip">
                  {item.frames.map((f, i) => <img key={i} src={f} alt={`frame ${i + 1}`} />)}
                </div>
              )}
              {item.pieceId != null && (item.label === "Studio" && item.text.startsWith("ACCEPTED")) && (
                <div style={{ marginTop: 8 }}>
                  <Link className="linklike" to={`/piece/${item.pieceId}`}>▸ view in gallery</Link>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
