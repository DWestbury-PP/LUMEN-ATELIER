import type { Piece, PieceDetail, StudioStatus } from "./types";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  pieces: (status = "approved") => get<Piece[]>(`/api/pieces?status=${status}`),
  piece: (id: number | string) => get<PieceDetail>(`/api/pieces/${id}`),
  status: () => get<StudioStatus>("/api/status"),
  commission: async (theme: string, patron: string, images: string[] = []): Promise<{ ok: boolean; error?: string }> => {
    const res = await fetch("/api/commissions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme, patron, images }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error || `Request failed (${res.status})` };
  },
};
