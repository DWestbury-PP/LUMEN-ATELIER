-- Lumen Atelier schema
-- NOTE: the studio also applies this schema idempotently at boot
-- (studio/src/db.ts ensureSchema) so managed Postgres providers that never
-- run this file still get the right tables. Keep the two in sync.

create table if not exists users (
  id            serial primary key,
  google_sub    text unique not null,
  email         text not null,
  name          text,
  picture       text,
  role          text not null default 'visitor',  -- visitor | requested | commissioner | admin
  requested_at  timestamptz,
  approved_at   timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists pieces (
  id            serial primary key,
  title         text,
  statement     text,
  theme         text,                -- visitor-requested theme; null = self-directed
  patron        text,                -- optional commissioner name
  brief         jsonb,               -- the Muse's concept brief
  glsl          text,                -- final (approved) shader source
  status        text not null default 'queued',  -- queued | composing | approved | declined | error
  seed          boolean not null default false,  -- calibration piece, not ensemble-made
  iterations    int not null default 0,
  created_at    timestamptz not null default now(),
  approved_at   timestamptz,
  commissioned_by int references users(id)
);

create table if not exists iterations (
  id            serial primary key,
  piece_id      int not null references pieces(id) on delete cascade,
  idx           int not null,
  glsl          text not null,
  artisan_notes text,
  compile_ok    boolean,
  compile_log   text,
  frames        jsonb,               -- array of data-URI PNGs captured by the studio renderer
  critique      jsonb,               -- the Critic's structured verdict
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

create index if not exists idx_pieces_status on pieces(status);
create index if not exists idx_iterations_piece on iterations(piece_id);
create index if not exists idx_events_piece on events(piece_id);
create index if not exists idx_events_created on events(created_at);
