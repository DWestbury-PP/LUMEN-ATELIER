import { ChangeEvent, FormEvent, useState } from "react";
import { useAuth } from "../lib/AuthContext";
import GoogleButton from "./GoogleButton";

// Downscale + JPEG-compress an inspirational image in the browser so uploads
// stay small (max edge 1024px, quality 0.8 — plenty for the Muse's eye).
async function compressImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.8);
}

export default function CommissionModal({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const [theme, setTheme] = useState("");
  const [patron, setPatron] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<"queued" | "proposed" | null>(null);

  async function pickImages(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).slice(0, 3 - images.length);
    e.target.value = "";
    try {
      const compressed = await Promise.all(files.map(compressImage));
      setImages((prev) => [...prev, ...compressed].slice(0, 3));
      setError(null);
    } catch {
      setError("Couldn't read one of those images — try a JPEG or PNG.");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/commissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme, patron, images }),
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
            <label>Inspirational images (optional, up to 3)</label>
            <div className="inspo-row">
              {images.map((img, i) => (
                <div className="inspo-thumb" key={i}>
                  <img src={img} alt={`inspiration ${i + 1}`} />
                  <button type="button" aria-label="remove image" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
              {images.length < 3 && (
                <label className="inspo-add">
                  +
                  <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={pickImages} />
                </label>
              )}
            </div>
            <p className="fine-warn" style={{ marginTop: 6 }}>
              The Muse studies these for palette, form, and mood — the essence, never a copy.
            </p>

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
