// Tag backfill: pieces from before the vocabulary existed get their tags
// from a cheap Haiku pass over title, statement, and brief — one at a time,
// only while the studio is idle. Pennies for the whole collection.
import { q } from "./db.js";
import { tagPiece } from "./agents.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startTagBackfill(busy: () => boolean): void {
  (async () => {
    const missing = await q.piecesMissingTags();
    if (missing.length === 0) return;
    console.log(`[tags] backfill: ${missing.length} pieces without tags`);
    let done = 0;
    for (const p of missing) {
      while (busy()) await sleep(5_000);
      try {
        const tags = await tagPiece(p);
        await q.setTags(p.id, tags);
        done++;
      } catch (err) {
        console.warn(`[tags] piece ${p.id}: ${String(err)}`);
        await sleep(5_000);
      }
      await sleep(300);
    }
    console.log(`[tags] backfill complete: ${done}/${missing.length}`);
  })().catch((err) => console.error("[tags] backfill crashed:", err));
}
