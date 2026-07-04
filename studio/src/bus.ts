// The studio's live wire: every step of the creative loop is announced here.
// SSE clients subscribe; noteworthy events are also persisted for replay.

import { EventEmitter } from "node:events";
import { q } from "./db.js";

export interface StudioEvent {
  type: string;
  pieceId: number | null;
  payload: Record<string, unknown>;
  at: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

// Ephemeral event types are streamed live but not persisted (e.g. per-token deltas).
const EPHEMERAL = new Set(["artisan.delta", "studio.heartbeat"]);

export function emitStudio(type: string, pieceId: number | null, payload: Record<string, unknown> = {}): void {
  const ev: StudioEvent = { type, pieceId, payload, at: new Date().toISOString() };
  emitter.emit("event", ev);
  if (!EPHEMERAL.has(type)) {
    // Frames ride the live stream but are NOT persisted here — they already
    // live on the iteration row, and duplicating multi-hundred-KB images into
    // the event log doubles storage and bloats every history replay.
    const stored = "frames" in payload ? { ...payload, frames: undefined } : payload;
    q.insertEvent(pieceId, type, stored).catch(() => {});
  }
}

export function onStudio(listener: (ev: StudioEvent) => void): () => void {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}
