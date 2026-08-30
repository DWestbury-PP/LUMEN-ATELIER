// Poster frames: one still per approved piece, rendered at tile resolution
// by the studio's own headless eye. The gallery hangs posters by default and
// brings only a handful of pieces to life at a time — a wall of 181 live
// shaders bogged visitors' machines; a wall of JPEGs costs them nothing.
import { q } from "./db.js";
import { renderFrames } from "./renderer.js";

export const POSTER = { width: 800, height: 450, time: 8.2 };

export async function renderPoster(glsl: string): Promise<Buffer | null> {
  const r = await renderFrames(glsl, { width: POSTER.width, height: POSTER.height, times: [POSTER.time] });
  const uri = r.ok ? r.frames?.[0] : undefined;
  const m = uri ? /^data:image\/jpeg;base64,(.+)$/.exec(uri) : null;
  return m ? Buffer.from(m[1], "base64") : null;
}

/** Render and store a poster for a piece. Resolves true once one is in place. */
export async function ensurePoster(id: number, glsl: string, force = false): Promise<boolean> {
  if (!force && (await q.hasPoster(id))) return true;
  const jpeg = await renderPoster(glsl);
  if (!jpeg) {
    console.warn(`[posters] piece ${id}: render failed`);
    return false;
  }
  await q.setPoster(id, jpeg);
  console.log(`[posters] piece ${id}: poster stored (${jpeg.length} bytes)`);
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fill in posters for every approved piece missing one — one at a time,
 *  and only while the studio is idle so it never competes with a critique. */
export function startPosterBackfill(busy: () => boolean): void {
  (async () => {
    const missing = await q.piecesMissingPoster();
    if (missing.length === 0) return;
    console.log(`[posters] backfill: ${missing.length} pieces without posters`);
    let done = 0;
    for (const p of missing) {
      while (busy()) await sleep(5_000);
      try {
        if (await ensurePoster(p.id, p.glsl)) done++;
      } catch (err) {
        console.warn(`[posters] piece ${p.id}: ${String(err)}`);
      }
      await sleep(400);
    }
    console.log(`[posters] backfill complete: ${done}/${missing.length}`);
  })().catch((err) => console.error("[posters] backfill crashed:", err));
}
