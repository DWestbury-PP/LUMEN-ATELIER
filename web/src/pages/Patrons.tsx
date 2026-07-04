// Curator's desk: approve or revoke commissioning privileges. Admin-only.

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../lib/AuthContext";

interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  picture: string | null;
  role: string;
  requested_at: string | null;
  approved_at: string | null;
  created_at: string;
}

export default function Patrons() {
  const { user, loaded } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/users");
    if (!res.ok) { setError("Not authorized."); return; }
    setUsers(await res.json());
  }, []);

  useEffect(() => {
    if (loaded && user?.role === "admin") load();
  }, [loaded, user, load]);

  async function setRole(id: number, role: "commissioner" | "visitor") {
    await fetch(`/api/admin/users/${id}/role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    load();
  }

  if (!loaded) return <div className="empty">…</div>;
  if (user?.role !== "admin") return <div className="empty">The curator's desk is private.</div>;

  const requested = (users ?? []).filter((u) => u.role === "requested");
  const others = (users ?? []).filter((u) => u.role !== "requested");

  return (
    <>
      <section className="hero" style={{ padding: "44px 0 8px" }}>
        <h1>The curator's desk.</h1>
        <p>Approve patrons to open the commission book to them. Requests appear here the moment they're made.</p>
      </section>

      {error && <div className="empty">{error}</div>}

      <div className="section-label">Awaiting approval {requested.length > 0 && `(${requested.length})`}</div>
      {requested.length === 0 && <p className="fine-warn">No pending requests.</p>}
      {requested.map((u) => (
        <div className="patron-row" key={u.id}>
          {u.picture && <img src={u.picture} alt="" referrerPolicy="no-referrer" />}
          <div className="patron-id">
            <strong>{u.name ?? u.email}</strong>
            <span>{u.email} · requested {u.requested_at ? new Date(u.requested_at).toLocaleString() : ""}</span>
          </div>
          <div className="patron-actions">
            <button className="btn solid" onClick={() => setRole(u.id, "commissioner")}>Approve</button>
            <button className="btn" onClick={() => setRole(u.id, "visitor")}>Decline</button>
          </div>
        </div>
      ))}

      <div className="section-label">Everyone</div>
      {others.map((u) => (
        <div className="patron-row" key={u.id}>
          {u.picture && <img src={u.picture} alt="" referrerPolicy="no-referrer" />}
          <div className="patron-id">
            <strong>{u.name ?? u.email}</strong>
            <span>{u.email} · <em>{u.role}</em></span>
          </div>
          <div className="patron-actions">
            {u.role === "visitor" && (
              <button className="btn" onClick={() => setRole(u.id, "commissioner")}>Grant</button>
            )}
            {u.role === "commissioner" && (
              <button className="btn" onClick={() => setRole(u.id, "visitor")}>Revoke</button>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
