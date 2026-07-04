import express from "express";
import { config, hasKey } from "./config.js";
import { q } from "./db.js";
import { onStudio, emitStudio } from "./bus.js";
import { state } from "./loop.js";

export function buildServer() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/status", async (_req, res) => {
    res.json({
      hasKey: hasKey(),
      phase: state.phase,
      currentPieceId: state.currentPieceId,
      queueLength: await q.queueLength(),
      models: config.models,
      maxIterations: config.maxIterations,
    });
  });

  app.get("/api/pieces", async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "approved";
    const rows = await q.listPieces(status === "all" ? undefined : status);
    res.json(rows);
  });

  app.get("/api/pieces/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "bad id" });
    const piece = await q.getPiece(id);
    if (!piece) return res.status(404).json({ error: "not found" });
    res.json(piece);
  });

  // Commission a piece. Lightly rate-limited per IP.
  const lastCommission = new Map<string, number>();
  app.post("/api/commissions", async (req, res) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    if (now - (lastCommission.get(ip) ?? 0) < 60_000) {
      return res.status(429).json({ error: "One commission per minute, please — the studio works at its own pace." });
    }
    const theme = String(req.body?.theme ?? "").trim().slice(0, 300);
    const patron = String(req.body?.patron ?? "").trim().slice(0, 80) || null;
    if (theme.length < 3) return res.status(400).json({ error: "Give the studio a theme (at least a few words)." });
    if ((await q.queueLength()) >= 12) {
      return res.status(429).json({ error: "The commission book is full for now — try again later." });
    }
    lastCommission.set(ip, now);
    const piece = await q.createPiece(theme, patron);
    emitStudio("commission.received", piece.id, { theme, patron });
    res.status(201).json(piece);
  });

  // Live studio feed (SSE). Sends recent history, then streams.
  app.get("/api/stream", async (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (type: string, data: unknown) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("hello", {
      hasKey: hasKey(),
      phase: state.phase,
      currentPieceId: state.currentPieceId,
      models: config.models,
    });
    try {
      const history = await q.recentEvents(120);
      send("history", history);
    } catch { /* history is best-effort */ }

    const off = onStudio((ev) => send("studio", ev));
    const heartbeat = setInterval(() => res.write(": hb\n\n"), 25_000);
    req.on("close", () => {
      off();
      clearInterval(heartbeat);
    });
  });

  return app;
}
