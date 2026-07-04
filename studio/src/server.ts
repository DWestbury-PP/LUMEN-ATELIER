import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import { config, hasKey } from "./config.js";
import { q } from "./db.js";
import { onStudio, emitStudio } from "./bus.js";
import { state } from "./loop.js";
import {
  clearSessionCookie, isAdminEmail, publicUser, setSessionCookie,
  userFromRequest, verifyGoogleCredential,
} from "./auth.js";

export function buildServer() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

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

  // ── Auth ──────────────────────────────────────────────────────────

  app.get("/api/auth/config", (_req, res) => {
    res.json({ clientId: config.googleClientId || null });
  });

  app.post("/api/auth/google", async (req, res) => {
    try {
      const credential = String(req.body?.credential ?? "");
      if (!credential) return res.status(400).json({ error: "missing credential" });
      const profile = await verifyGoogleCredential(credential);
      const user = await q.upsertUser(profile, isAdminEmail(profile.email));
      setSessionCookie(res, user.google_sub);
      res.json({ user: publicUser(user) });
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : "sign-in failed" });
    }
  });

  app.post("/api/auth/logout", (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get("/api/me", async (req, res) => {
    const user = await userFromRequest(req);
    res.json({ user: user ? publicUser(user) : null });
  });

  app.post("/api/me/request-commission", async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) return res.status(401).json({ error: "Sign in first." });
    if (user.role === "commissioner" || user.role === "admin") {
      return res.json({ user: publicUser(user) });
    }
    const updated = (await q.requestCommission(user.id)) ?? user;
    emitStudio("patron.requested", null, { email: updated.email, name: updated.name });
    res.json({ user: publicUser(updated) });
  });

  // ── Admin: patron approval ────────────────────────────────────────

  app.get("/api/admin/users", async (req, res) => {
    const user = await userFromRequest(req);
    if (user?.role !== "admin") return res.status(403).json({ error: "admins only" });
    res.json((await q.listUsers()).map((u) => ({
      ...publicUser(u),
      requested_at: u.requested_at,
      approved_at: u.approved_at,
      created_at: u.created_at,
    })));
  });

  app.post("/api/admin/users/:id/role", async (req, res) => {
    const user = await userFromRequest(req);
    if (user?.role !== "admin") return res.status(403).json({ error: "admins only" });
    const role = String(req.body?.role ?? "");
    if (role !== "commissioner" && role !== "visitor") {
      return res.status(400).json({ error: "role must be commissioner or visitor" });
    }
    const target = await q.setUserRole(Number(req.params.id), role);
    if (!target) return res.status(404).json({ error: "user not found (or is an admin)" });
    res.json({ ...publicUser(target), requested_at: target.requested_at, approved_at: target.approved_at });
  });

  // ── Pieces ────────────────────────────────────────────────────────

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

  // Commission a piece — requires the commissioning privilege.
  const lastCommission = new Map<number, number>();
  app.post("/api/commissions", async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: "Sign in with Google to commission a piece." });
    }
    if (user.role !== "commissioner" && user.role !== "admin") {
      return res.status(403).json({
        error: user.role === "requested"
          ? "Your commissioning request is still awaiting the curator's approval."
          : "Commissioning requires approval — request the privilege from your account menu.",
      });
    }
    const now = Date.now();
    if (now - (lastCommission.get(user.id) ?? 0) < 60_000) {
      return res.status(429).json({ error: "One commission per minute, please — the studio works at its own pace." });
    }
    const theme = String(req.body?.theme ?? "").trim().slice(0, 300);
    const patron = String(req.body?.patron ?? "").trim().slice(0, 80) || user.name || user.email;
    if (theme.length < 3) return res.status(400).json({ error: "Give the studio a theme (at least a few words)." });
    if ((await q.queueLength()) >= 12) {
      return res.status(429).json({ error: "The commission book is full for now — try again later." });
    }
    lastCommission.set(user.id, now);
    const piece = await q.createPiece(theme, patron, user.id);
    emitStudio("commission.received", piece.id, { theme, patron });
    res.status(201).json(piece);
  });

  // ── Live studio feed (SSE) ────────────────────────────────────────

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

  // ── Static gallery (single-container deployments) ────────────────

  if (config.staticDir) {
    app.use(express.static(config.staticDir, { maxAge: "1h", index: "index.html" }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(config.staticDir, "index.html"));
    });
  }

  return app;
}
