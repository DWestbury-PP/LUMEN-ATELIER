import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });

export async function waitForDb(maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await pool.query("select 1");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("database never became reachable");
}

export interface PieceRow {
  id: number;
  title: string | null;
  statement: string | null;
  theme: string | null;
  patron: string | null;
  brief: unknown;
  glsl: string | null;
  status: string;
  seed: boolean;
  iterations: number;
  created_at: string;
  approved_at: string | null;
}

export const q = {
  async nextQueued(): Promise<PieceRow | null> {
    const r = await pool.query(
      "select * from pieces where status = 'queued' order by id asc limit 1"
    );
    return r.rows[0] ?? null;
  },

  async createPiece(theme: string | null, patron: string | null): Promise<PieceRow> {
    const r = await pool.query(
      "insert into pieces (theme, patron, status) values ($1, $2, 'queued') returning *",
      [theme, patron]
    );
    return r.rows[0];
  },

  async setStatus(id: number, status: string): Promise<void> {
    await pool.query("update pieces set status = $2 where id = $1", [id, status]);
  },

  async setBrief(id: number, brief: unknown): Promise<void> {
    await pool.query("update pieces set brief = $2 where id = $1", [id, JSON.stringify(brief)]);
  },

  async approvePiece(id: number, glsl: string, title: string, statement: string, iterations: number): Promise<void> {
    await pool.query(
      `update pieces set status = 'approved', glsl = $2, title = $3, statement = $4,
        iterations = $5, approved_at = now() where id = $1`,
      [id, glsl, title, statement, iterations]
    );
  },

  async declinePiece(id: number, iterations: number): Promise<void> {
    await pool.query(
      "update pieces set status = 'declined', iterations = $2 where id = $1",
      [id, iterations]
    );
  },

  async insertIteration(pieceId: number, idx: number, it: {
    glsl: string; artisanNotes: string | null; compileOk: boolean;
    compileLog: string | null; frames: string[] | null; critique: unknown;
  }): Promise<void> {
    await pool.query(
      `insert into iterations (piece_id, idx, glsl, artisan_notes, compile_ok, compile_log, frames, critique)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (piece_id, idx) do update set
         glsl = excluded.glsl, artisan_notes = excluded.artisan_notes,
         compile_ok = excluded.compile_ok, compile_log = excluded.compile_log,
         frames = excluded.frames, critique = excluded.critique`,
      [pieceId, idx, it.glsl, it.artisanNotes, it.compileOk, it.compileLog,
       it.frames ? JSON.stringify(it.frames) : null,
       it.critique ? JSON.stringify(it.critique) : null]
    );
  },

  async listPieces(status?: string): Promise<PieceRow[]> {
    if (status) {
      const r = await pool.query(
        "select id, title, statement, theme, patron, brief, glsl, status, seed, iterations, created_at, approved_at from pieces where status = $1 order by coalesce(approved_at, created_at) desc",
        [status]
      );
      return r.rows;
    }
    const r = await pool.query("select * from pieces order by id desc limit 200");
    return r.rows;
  },

  async getPiece(id: number): Promise<(PieceRow & { iterationRows: unknown[] }) | null> {
    const p = await pool.query("select * from pieces where id = $1", [id]);
    if (!p.rows[0]) return null;
    const its = await pool.query(
      "select idx, glsl, artisan_notes, compile_ok, compile_log, frames, critique, created_at from iterations where piece_id = $1 order by idx asc",
      [id]
    );
    return { ...p.rows[0], iterationRows: its.rows };
  },

  async queueLength(): Promise<number> {
    const r = await pool.query("select count(*)::int as n from pieces where status = 'queued'");
    return r.rows[0].n;
  },

  async pieceCount(): Promise<number> {
    const r = await pool.query("select count(*)::int as n from pieces");
    return r.rows[0].n;
  },

  async lastAutoCreatedAt(): Promise<Date | null> {
    const r = await pool.query(
      "select max(created_at) as t from pieces where theme is null and seed = false"
    );
    return r.rows[0].t ? new Date(r.rows[0].t) : null;
  },

  async recentEvents(limit = 200): Promise<unknown[]> {
    const r = await pool.query(
      "select id, piece_id, type, payload, created_at from events order by id desc limit $1",
      [limit]
    );
    return r.rows.reverse();
  },

  async insertEvent(pieceId: number | null, type: string, payload: unknown): Promise<void> {
    await pool.query(
      "insert into events (piece_id, type, payload) values ($1, $2, $3)",
      [pieceId, type, JSON.stringify(payload ?? {})]
    );
  },

  async insertSeed(s: { title: string; statement: string; glsl: string; brief: unknown }): Promise<void> {
    await pool.query(
      `insert into pieces (title, statement, glsl, brief, status, seed, approved_at)
       values ($1, $2, $3, $4, 'approved', true, now())`,
      [s.title, s.statement, s.glsl, JSON.stringify(s.brief)]
    );
  },
};
