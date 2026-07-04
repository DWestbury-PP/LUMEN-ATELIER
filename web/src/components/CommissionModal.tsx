import { FormEvent, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/AuthContext";
import GoogleButton from "./GoogleButton";

export default function CommissionModal({ onClose }: { onClose: () => void }) {
  const { user, refresh } = useAuth();
  const [theme, setTheme] = useState("");
  const [patron, setPatron] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [requested, setRequested] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await api.commission(theme, patron);
    setBusy(false);
    if (result.ok) setDone(true);
    else setError(result.error || "Something went wrong.");
  }

  async function requestPrivilege() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/me/request-commission", { method: "POST" });
    setBusy(false);
    if (res.ok) { setRequested(true); await refresh(); }
    else setError("Could not submit the request — try again.");
  }

  const canCommission = user && (user.role === "commissioner" || user.role === "admin");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Commission a piece</h2>

        {/* Not signed in → invite to sign in */}
        {!user && (
          <>
            <p>
              Commissions put the ensemble to work on <em>your</em> theme — which spends real
              compute — so the commission book is reserved for approved patrons. Sign in with
              Google to request the privilege; the curator approves patrons personally.
            </p>
            <GoogleButton />
            <div className="row">
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {/* Signed in, no privilege yet */}
        {user && !canCommission && (
          <>
            {user.role === "requested" || requested ? (
              <p className="ok">
                Your request is with the curator. Once approved, the Commission button
                will open the studio's book for you — check back soon.
              </p>
            ) : (
              <>
                <p>
                  You're signed in as <strong>{user.name ?? user.email}</strong>. Commissioning
                  is granted per-patron by the curator. Request the privilege below — approvals
                  are personal and usually quick.
                </p>
                <button className="btn solid" onClick={requestPrivilege} disabled={busy}>
                  {busy ? "Sending…" : "Request commissioning privilege"}
                </button>
              </>
            )}
            {error && <div className="error">{error}</div>}
            <div className="row">
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </>
        )}

        {/* Approved patron → the commission form */}
        {canCommission && (done ? (
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
            <p>
              Give the ensemble a theme — a feeling, a place, a phenomenon, an artist to honor.
              The Muse will interpret it, the Artisan will realize it, and the Critic will
              decide when it's worthy of the gallery.
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
              placeholder={user?.name ?? "Anonymous patron"}
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
        ))}
      </div>
    </div>
  );
}
