// The curator's desk: every visitor-submitted commission waits here for a
// personal decision before the ensemble spends a token on it. Admin-only.

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../lib/AuthContext";

interface Proposal {
  id: number;
  theme: string | null;
  patron: string | null;
  created_at: string;
  submitter_email: string | null;
  submitter_name: string | null;
}

interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  picture: string | null;
  role: string;
  created_at: string;
}

export default function Patrons() {
  const { user, loaded } = useAuth();
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, u] = await Promise.all([
      fetch("/api/admin/proposals"),
      fetch("/api/admin/users"),
    ]);
    if (!p.ok || !u.ok) { setError("Not authorized."); return; }
    setProposals(await p.json());
    setUsers(await u.json());
  }, []);

  useEffect(() => {
    if (loaded && user?.role === "admin") {
      load();
      const iv = setInterval(load, 15_000);
      return () => clearInterval(iv);
    }
  }, [loaded, user, load]);

  async function resolve(id: number, action: "approve" | "decline") {
    await fetch(`/api/admin/proposals/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    load();
  }

  if (!loaded) return <div className="empty">…</div>;
  if (user?.role !== "admin") return <div className="empty">The curator's desk is private.</div>;

  return (
    <>
      <section className="hero" style={{ padding: "44px 0 8px" }}>
        <h1>The curator's desk.</h1>
        <p>
          Every visitor-submitted commission waits here for your decision. Approve a theme
          and the ensemble takes it up immediately; decline it and no tokens are spent.
          The studio's own self-directed work never needs approval.
        </p>
      </section>

      {error && <div className="empty">{error}</div>}

      <div className="section-label">
        Proposals awaiting review {proposals && proposals.length > 0 && `(${proposals.length})`}
      </div>
      {proposals?.length === 0 && <p className="fine-warn">Nothing waiting. The book is clear.</p>}
      {proposals?.map((p) => (
        <div className="patron-row" key={p.id}>
          <div className="patron-id" style={{ flex: 1 }}>
            <strong>“{p.theme}”</strong>
            <span>
              {p.submitter_name ?? p.submitter_email ?? "unknown"} ({p.submitter_email})
              {p.patron && p.patron !== p.submitter_name && <> · credited as “{p.patron}”</>}
              {" · "}{new Date(p.created_at).toLocaleString()}
            </span>
          </div>
          <div className="patron-actions">
            <button className="btn solid" onClick={() => resolve(p.id, "approve")}>Approve</button>
            <button className="btn" onClick={() => resolve(p.id, "decline")}>Decline</button>
          </div>
        </div>
      ))}

      <div className="section-label">Signed-in patrons</div>
      {users?.map((u) => (
        <div className="patron-row" key={u.id}>
          {u.picture && <img src={u.picture} alt="" referrerPolicy="no-referrer" />}
          <div className="patron-id">
            <strong>{u.name ?? u.email}</strong>
            <span>{u.email} · <em>{u.role}</em> · joined {new Date(u.created_at).toLocaleDateString()}</span>
          </div>
        </div>
      ))}
    </>
  );
}
