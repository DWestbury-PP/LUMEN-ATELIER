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
      autoCreateIntervalMin: config.autoCreateIntervalMin,
      spend24h: await q.spend24h(),
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

  // ── Admin: user management ───────────────────────────────────────

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

  // Submit a commission PROPOSAL. Every proposal is reviewed by the curator
  // before the ensemble spends a single token on it. Admin proposals are
  // auto-approved (the curator doesn't need to approve their own themes).
  const lastCommission = new Map<number, number>();
  app.post("/api/commissions", async (req, res) => {
    const user = await userFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: "Sign in with Google to propose a commission." });
    }
    const now = Date.now();
    if (now - (lastCommission.get(user.id) ?? 0) < 60_000) {
      return res.status(429).json({ error: "One proposal per minute, please — the studio works at its own pace." });
    }
    if (user.role !== "admin" && (await q.countOpenProposals(user.id)) >= 3) {
      return res.status(429).json({ error: "You already have three proposals awaiting the curator — let those settle first." });
    }
    const theme = String(req.body?.theme ?? "").trim().slice(0, 300);
    const patron = String(req.body?.patron ?? "").trim().slice(0, 80) || user.name || user.email;
    if (theme.length < 3) return res.status(400).json({ error: "Give the studio a theme (at least a few words)." });
    lastCommission.set(user.id, now);

    if (user.role === "admin") {
      if ((await q.queueLength()) >= 12) {
        return res.status(429).json({ error: "The studio queue is full — try again shortly." });
      }
      const piece = await q.createPiece(theme, patron, user.id);
      emitStudio("commission.received", piece.id, { theme, patron });
      return res.status(201).json({ ...piece, approved: true });
    }

    const piece = await q.createProposal(theme, patron, user.id);
    emitStudio("commission.proposed", piece.id, { theme, patron });
    res.status(201).json({ ...piece, approved: false });
  });

  // Admin: review proposals case by case.
  app.get("/api/admin/proposals", async (req, res) => {
    const user = await userFromRequest(req);
    if (user?.role !== "admin") return res.status(403).json({ error: "admins only" });
    res.json(await q.listProposals());
  });

  app.post("/api/admin/proposals/:id", async (req, res) => {
    const user = await userFromRequest(req);
    if (user?.role !== "admin") return res.status(403).json({ error: "admins only" });
    const approve = req.body?.action === "approve";
    if (!approve && req.body?.action !== "decline") {
      return res.status(400).json({ error: "action must be approve or decline" });
    }
    const piece = await q.resolveProposal(Number(req.params.id), approve);
    if (!piece) return res.status(404).json({ error: "proposal not found (or already resolved)" });
    emitStudio(approve ? "commission.received" : "commission.declined", piece.id, {
      theme: piece.theme, patron: piece.patron,
    });
    res.json(piece);
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
