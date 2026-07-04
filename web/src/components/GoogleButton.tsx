// Renders the official "Sign in with Google" button (Google Identity Services)
// and exchanges the returned ID token for a studio session cookie.

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../lib/AuthContext";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

let gisLoading: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load Google sign-in"));
      document.head.appendChild(s);
    });
  }
  return gisLoading;
}

export default function GoogleButton({ onSignedIn }: { onSignedIn?: () => void }) {
  const { clientId, refresh } = useAuth();
  const slot = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientId || !slot.current) return;
    let cancelled = false;
    loadGis().then(() => {
      if (cancelled || !slot.current || !window.google) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: async ({ credential }) => {
          const res = await fetch("/api/auth/google", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ credential }),
          });
          if (res.ok) {
            await refresh();
            onSignedIn?.();
          } else {
            const body = await res.json().catch(() => ({}));
            setError(body.error || "Sign-in failed.");
          }
        },
      });
      window.google.accounts.id.renderButton(slot.current, {
        theme: "filled_black", size: "large", shape: "rectangular", text: "signin_with",
      });
    }).catch((e) => setError(String(e.message || e)));
    return () => { cancelled = true; };
  }, [clientId, refresh, onSignedIn]);

  if (!clientId) {
    return <div className="fine-warn">Sign-in isn't configured on this gallery yet.</div>;
  }
  return (
    <div>
      <div ref={slot} />
      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
