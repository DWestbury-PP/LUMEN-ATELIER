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

// The studio owns its schema: managed Postgres (e.g. Railway) never runs the
// repo's init.sql, so boot applies the same idempotent DDL everywhere.
export async function ensureSchema(): Promise<void> {
  await pool.query(`
    create table if not exists pieces (
      id            serial primary key,
      title         text,
      statement     text,
      theme         text,
      patron        text,
      brief         jsonb,
      glsl          text,
      status        text not null default 'queued',
      seed          boolean not null default false,
      iterations    int not null default 0,
      created_at    timestamptz not null default now(),
      approved_at   timestamptz
    );
    create table if not exists iterations (
      id            serial primary key,
      piece_id      int not null references pieces(id) on delete cascade,
      idx           int not null,
      glsl          text not null,
      artisan_notes text,
      compile_ok    boolean,
      compile_log   text,
      frames        jsonb,
      critique      jsonb,
      created_at    timestamptz not null default now(),
      unique (piece_id, idx)
    );
    create table if not exists events (
      id            bigserial primary key,
      piece_id      int,
      type          text not null,
      payload       jsonb,
      created_at    timestamptz not null default now()
    );
    create table if not exists users (
      id            serial primary key,
      google_sub    text unique not null,
      email         text not null,
      name          text,
      picture       text,
      role          text not null default 'visitor',
      requested_at  timestamptz,
      approved_at   timestamptz,
      created_at    timestamptz not null default now()
    );
    alter table pieces add column if not exists commissioned_by int references users(id);
    alter table pieces add column if not exists ledger jsonb;
    alter table pieces add column if not exists curator_note text;
    create index if not exists idx_pieces_status on pieces(status);
    create index if not exists idx_iterations_piece on iterations(piece_id);
    create index if not exists idx_events_piece on events(piece_id);
    create index if not exists idx_events_created on events(created_at);
  `);
}

export interface UserRow {
  id: number;
  google_sub: string;
  email: string;
  name: string | null;
  picture: string | null;
  role: "visitor" | "requested" | "commissioner" | "admin";
  requested_at: string | null;
  approved_at: string | null;
  created_at: string;
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

  async createPiece(theme: string | null, patron: string | null, userId: number | null = null): Promise<PieceRow> {
    const r = await pool.query(
      "insert into pieces (theme, patron, status, commissioned_by) values ($1, $2, 'queued', $3) returning *",
      [theme, patron, userId]
    );
    return r.rows[0];
  },

  // ── Curator's prerogative ──

  // Send a finished piece back to the studio, optionally with direction.
  async curatorReiterate(id: number, note: string | null): Promise<PieceRow | null> {
    const r = await pool.query(
      `update pieces set status = 'queued', curator_note = $2
       where id = $1 and status in ('approved','declined','error','rejected') returning *`,
      [id, note]
    );
    return r.rows[0] ?? null;
  },

  async clearCuratorNote(id: number): Promise<void> {
    await pool.query("update pieces set curator_note = null where id = $1", [id]);
  },

  // Curator override: hang a specific rendered draft in the gallery.
  async approveDraftOverride(pieceId: number, idx: number): Promise<PieceRow | null> {
    const it = await pool.query(
      "select glsl from iterations where piece_id = $1 and idx = $2 and compile_ok = true",
      [pieceId, idx]
    );
    if (!it.rows[0]) return null;
    const r = await pool.query(
      `update pieces set status = 'approved', glsl = $2, approved_at = now(),
         title = coalesce(title, brief->>'title_working', 'Untitled'),
         statement = coalesce(statement, 'Hung by the curator''s decision.')
       where id = $1 returning *`,
      [pieceId, it.rows[0].glsl]
    );
    return r.rows[0] ?? null;
  },

  // Next free iteration index (re-iterated pieces keep counting: Draft 4, 5…)
  async nextIterationIdx(pieceId: number): Promise<number> {
    const r = await pool.query(
      "select coalesce(max(idx), -1) + 1 as next from iterations where piece_id = $1",
      [pieceId]
    );
    return r.rows[0].next;
  },

  async lastCritiquedIteration(pieceId: number): Promise<{ glsl: string; critique: unknown } | null> {
    const r = await pool.query(
      `select glsl, critique from iterations
       where piece_id = $1 and critique is not null order by idx desc limit 1`,
      [pieceId]
    );
    return r.rows[0] ?? null;
  },

  async setPieceLedger(id: number, ledger: unknown): Promise<void> {
    await pool.query("update pieces set ledger = $2 where id = $1", [id, JSON.stringify(ledger)]);
  },

  // Rolling 24h spend across all pieces (auto + commissioned).
  async spend24h(): Promise<{ cost_usd: number; pieces: number }> {
    const r = await pool.query(
      `select coalesce(sum((ledger->>'cost_usd')::numeric), 0)::float as cost, count(*)::int as n
       from pieces where ledger is not null and created_at > now() - interval '24 hours'`
    );
    return { cost_usd: Math.round(r.rows[0].cost * 100) / 100, pieces: r.rows[0].n };
  },

  // Re-queue pieces orphaned in 'composing' by a mid-work restart.
  async requeueOrphans(): Promise<number> {
    const r = await pool.query("update pieces set status = 'queued' where status = 'composing'");
    return r.rowCount ?? 0;
  },

  // ── Commission proposals (curator approval required) ──

  async createProposal(theme: string, patron: string | null, userId: number): Promise<PieceRow> {
    const r = await pool.query(
      "insert into pieces (theme, patron, status, commissioned_by) values ($1, $2, 'proposed', $3) returning *",
      [theme, patron, userId]
    );
    return r.rows[0];
  },

  async countOpenProposals(userId: number): Promise<number> {
    const r = await pool.query(
      "select count(*)::int as n from pieces where commissioned_by = $1 and status = 'proposed'",
      [userId]
    );
    return r.rows[0].n;
  },

  async listProposals(): Promise<(PieceRow & { submitter_email: string | null; submitter_name: string | null })[]> {
    const r = await pool.query(
      `select p.*, u.email as submitter_email, u.name as submitter_name
       from pieces p left join users u on u.id = p.commissioned_by
       where p.status = 'proposed' order by p.created_at asc`
    );
    return r.rows;
  },

  async resolveProposal(pieceId: number, approve: boolean): Promise<PieceRow | null> {
    const r = await pool.query(
      "update pieces set status = $2 where id = $1 and status = 'proposed' returning *",
      [pieceId, approve ? "queued" : "rejected"]
    );
    return r.rows[0] ?? null;
  },

  // ── Users & roles ──

  async userBySub(sub: string): Promise<UserRow | null> {
    const r = await pool.query("select * from users where google_sub = $1", [sub]);
    return r.rows[0] ?? null;
  },

  async upsertUser(p: { sub: string; email: string; name: string | null; picture: string | null }, admin: boolean): Promise<UserRow> {
    const r = await pool.query(
      `insert into users (google_sub, email, name, picture, role)
       values ($1, $2, $3, $4, $5)
       on conflict (google_sub) do update set
         email = excluded.email, name = excluded.name, picture = excluded.picture,
         role = case when $6 then 'admin' else users.role end
       returning *`,
      [p.sub, p.email, p.name, p.picture, admin ? "admin" : "visitor", admin]
    );
    return r.rows[0];
  },

  async requestCommission(userId: number): Promise<UserRow | null> {
    const r = await pool.query(
      `update users set role = 'requested', requested_at = now()
       where id = $1 and role = 'visitor' returning *`,
      [userId]
    );
    return r.rows[0] ?? null;
  },

  async setUserRole(userId: number, role: "visitor" | "commissioner"): Promise<UserRow | null> {
    const r = await pool.query(
      `update users set role = $2,
         approved_at = case when $2 = 'commissioner' then now() else approved_at end
       where id = $1 and role <> 'admin' returning *`,
      [userId, role]
    );
    return r.rows[0] ?? null;
  },

  async listUsers(): Promise<UserRow[]> {
    const r = await pool.query(
      `select * from users order by
         case role when 'requested' then 0 when 'commissioner' then 1 when 'admin' then 2 else 3 end,
         requested_at desc nulls last, created_at desc limit 500`
    );
    return r.rows;
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
