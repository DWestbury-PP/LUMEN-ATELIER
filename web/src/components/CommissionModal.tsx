import { FormEvent, useState } from "react";
import { useAuth } from "../lib/AuthContext";
import GoogleButton from "./GoogleButton";

export default function CommissionModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const [theme, setTheme] = useState("");
  const [patron, setPatron] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"queued" | "proposed" | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/commissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme, patron }),
    });
    setBusy(false);
    if (res.ok) {
      const body = await res.json();
      setResult(body.approved ? "queued" : "proposed");
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error || "Something went wrong.");
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Commission a piece</h2>

        {!user && (
          <>
            <p>
              Give the ensemble a theme and, if the curator approves it, the studio goes to
              work — Muse, Artisan, and Critic, live on the studio floor. Because every
              commission spends real compute, proposals are reviewed personally. Sign in
              with Google to submit yours.
            </p>
            <GoogleButton />
            <div className="row">
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {user && (result ? (
          <>
            <div className="ok">
              {result === "queued"
                ? "Your commission is in the studio's book. The ensemble will begin shortly — follow along on the Studio Floor."
                : "Your proposal is with the curator. If it's approved, the ensemble takes it up and you'll find the result in the gallery — check back soon."}
            </div>
            <div className="row">
              <button className="btn solid" onClick={onClose}>Close</button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <p>
              Propose a theme — a feeling, a place, a phenomenon, an artist to honor.
              The curator reviews every proposal before the studio takes it up; approved
              themes go to the Muse, the Artisan, and finally the Critic.
            </p>
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
            <label htmlFor="patron">Credited as (optional)</label>
            <input
              id="patron"
              value={patron}
              onChange={(e) => setPatron(e.target.value)}
              placeholder={user.name ?? "Anonymous patron"}
              maxLength={80}
            />
            {error && <div className="error">{error}</div>}
            <div className="row">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn solid" disabled={busy || theme.trim().length < 3}>
                {busy ? "Submitting…" : "Submit proposal"}
              </button>
            </div>
          </form>
        ))}
      </div>
    </div>
  );
}
