import { FormEvent, useState } from "react";
import { api } from "../lib/api";

export default function CommissionModal({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useState("");
  const [patron, setPatron] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await api.commission(theme, patron);
    setBusy(false);
    if (result.ok) setDone(true);
    else setError(result.error || "Something went wrong.");
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Commission a piece</h2>
        <p>
          Give the ensemble a theme — a feeling, a place, a phenomenon, an artist to honor.
          The Muse will interpret it, the Artisan will realize it, and the Critic will
          decide when it's worthy of the gallery. Watch it happen live on the studio floor.
        </p>
        {done ? (
          <>
            <div className="ok">
              Your commission is in the studio's book. The ensemble will begin shortly —
              follow along on the Studio Floor.
            </div>
            <div className="row">
              <button className="btn solid" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="theme">Theme</label>
            <textarea
              id="theme"
              rows={3}
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="e.g. the moment a thunderstorm breaks over a wheat field"
              maxLength={300}
              required
            />
            <label htmlFor="patron">Your name (optional, credited as patron)</label>
            <input
              id="patron"
              value={patron}
              onChange={(e) => setPatron(e.target.value)}
              placeholder="Anonymous"
              maxLength={80}
            />
            {error && <div className="error">{error}</div>}
            <div className="row">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn solid" disabled={busy || theme.trim().length < 3}>
                {busy ? "Submitting…" : "Commission"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
