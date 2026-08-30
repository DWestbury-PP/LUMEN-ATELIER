<div align="center">

# ◈ Lumen Atelier

### An autonomous art studio where the artist can see its own work

**Live gallery: [lumen-atelier.up.railway.app](https://lumen-atelier.up.railway.app)**

Three Claude models run a working atelier: the **Muse** writes a concept brief, the
**Artisan** writes a real-time GLSL shader, and the **Critic** *looks at the actual
rendered frames* — approving, or sending the work back with notes — until the piece
earns its place in the gallery.

`Claude Sonnet 5 · Opus 5` · `WebGL2 / GLSL ES 3.00` · `React` · `Node/TS` · `Postgres` · `Docker Compose` · `Railway`

</div>

---

## The idea

Most "AI art" is fire-and-forget: prompt in, image out, no judgment in the loop.
Lumen Atelier closes the loop. The studio **renders its own work headlessly, captures
frames, and shows them to a vision model acting as a gallery critic** — a genuine
perception-action cycle. Draft, look, critique, revise. Only the Critic can admit a
piece to the permanent collection, and the entire creative argument (brief → drafts →
compile errors → critiques → revisions) is preserved and browsable for every piece.

The medium is the demoscene's: full-screen fragment shaders, pure math, no textures.
Which means every finished piece ships as *text* — and renders live, in real time, on
every visitor's GPU. The gallery is never a video. It's the artwork itself, executing.

This is not hypothetical: the studio runs continuously in production, self-commissioning
a new piece on a fixed cadence. Its first works — including *Alchemy of the Lattice*
(approved on draft 3 after the Critic twice rejected "oversaturated lime-green plasma")
— are hanging in the live gallery with their full revision histories.

## The ensemble

| Role | Default model | Job |
|---|---|---|
| **The Muse** | `claude-sonnet-5` | Writes the concept brief: one idea, a disciplined palette, concrete motion. Grounds briefs in real art-history research via Tavily when a key is present. |
| **The Artisan** | `claude-opus-5` | Realizes the brief as a GLSL ES 3.00 shader, in the demoscene tradition. Streams its work token-by-token to the live studio floor. Repairs its own compile errors. |
| **The Critic** | `claude-opus-5` | The gate. Examines 4 rendered frames (t = 0.8s → 15s), scores composition / color / motion / brief-fidelity, and issues a verdict: approve, revise with concrete notes, or — on the final iteration — decline. |

The models are configurable via environment; recast the ensemble however you like.

## What's in the gallery

- **The Collection** — approved pieces. Each hangs as a *poster* (a still rendered
  by the studio's own headless eye) and comes to life as a live WebGL2 shader only
  while it holds your attention — the few tiles nearest the viewport centre, plus
  the one under your pointer. A wall of 180 live shaders bogged visitors' machines;
  a wall of posters costs nothing. A **finder** above the wall searches titles,
  statements and tags, and filters by tag (`/?tag=meditative` is a shareable link).
- **Piece pages** — title, artist statement, the Muse's brief, and the full creative
  process: every draft viewable *live* (including rejected ones), with the Critic's
  scores and notes.
- **The Studio Floor** — a live view of the piece being made right now: the Artisan's
  code streaming in, captured frames, verdicts as they land.
- **Commissions** — visitors propose a theme, optionally with up to three inspiration
  images the Muse actually looks at; see *Governance* below.
- **Exhibit mode** — fullscreen ambient display, pieces cross-fading. Point a spare
  monitor at `/exhibit`.

## Governance: who may spend the studio's tokens

The ensemble is free; the public is vetted. The studio **self-commissions and iterates
autonomously all day** — research, ideation, draft/critique cycles — with no human in
the loop. Visitor commissions, however, spend real compute on someone else's idea, so
they pass through a curator:

1. Anyone can browse. Nothing requires an account.
2. Proposing a commission requires **Sign in with Google** (ID-token verified
   server-side, HMAC-signed httpOnly session — no passwords stored).
3. Every proposal lands on the **curator's desk** (`/patrons`, admin-only) and consumes
   zero tokens until the curator explicitly approves it. Declined proposals never run.
4. Per-user limits: one proposal per minute, at most three awaiting review.

The curator's brush is broader than approve/decline: any piece can be **sent back to
the studio with notes**, **forked into a fresh redraft** with additional direction,
or removed from the collection — and every piece page carries its **usage ledger**,
the actual model spend that made it. Admins are designated by `ADMIN_EMAILS` and are
auto-granted the role on sign-in.

## Architecture

```
            ┌────────────────────────────────────────────────────┐
            │  visitors (browser, WebGL2 — art renders on GPU)   │
            └───────────────────────┬────────────────────────────┘
                                    │ https
┌───────────────────────────────────▼───────────────────────────────────┐
│  app — Node/TS studio orchestrator + built React gallery              │
│  the creative loop: Muse → Artisan → render → Critic                  │
│  commissions & curator API · Google auth · SSE studio floor · static  │
└──────────┬─────────────────────────────────────────┬──────────────────┘
           │ POST /render (private network)          │ SQL
┌──────────▼────────────────────┐        ┌───────────▼──────────┐
│  renderer                     │        │  Postgres            │
│  headless Chromium +          │        │  pieces · iterations │
│  SwiftShader WebGL2 —         │        │  events · users      │
│  the studio's *eyes*          │        │                      │
└───────────────────────────────┘        └──────────────────────┘
```

The renderer needs no GPU — SwiftShader rasterizes shaders in software, which is what
makes the perception loop portable: identical behavior on a laptop, a Mac mini, or a
cloud container. The studio owns its schema (idempotent migration at boot) and recovers
pieces orphaned by restarts, so redeploys never strand work.

**Production** runs on [Railway](https://railway.com) as three services: `app`
(public, built from `Dockerfile` — the studio serving the compiled gallery),
`renderer` (private networking only), and managed Postgres. Both services
auto-deploy from this repository on push to `main`.

**Local development** uses the same code as four compose containers (nginx-served
gallery, studio, renderer, Postgres):

```bash
cp .env.example .env    # add your ANTHROPIC_API_KEY (and friends)
docker compose up -d --build
open http://localhost:7777
```

Without an API key the ensemble sleeps, but the gallery still opens with three
hand-written **calibration pieces** so the pipeline is visible end-to-end.

### Environment

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Wakes the ensemble. Without it: gallery-only mode. |
| `TAVILY_API_KEY` | Optional — the Muse's art-history research wing. |
| `GOOGLE_CLIENT_ID` | Enables Sign in with Google (commission proposals). |
| `SESSION_SECRET` | HMAC key for session cookies (`openssl rand -hex 32`). |
| `ADMIN_EMAILS` | Comma-separated curator emails (auto-admin on sign-in). |
| `MUSE_MODEL` / `ARTISAN_MODEL` / `CRITIC_MODEL` | Recast the ensemble. |
| `AUTO_CREATE` / `AUTO_CREATE_INTERVAL_MIN` | Self-commissioning cadence (default: every 2 hours, ~12 pieces/day). |
| `ARTISAN_EFFORT` | Reasoning effort for the Artisan (default `medium` — keeps it painting, not pondering). |
| `MAX_ITERATIONS` | Revision rounds before the Critic's final ruling (default 4). |

## The shader contract

Every piece is a GLSL ES 3.00 fragment shader with a fixed interface:

```glsl
#version 300 es
precision highp float;
uniform vec2 iResolution;   // viewport, pixels
uniform float iTime;        // seconds
out vec4 fragColor;
```

No textures, no buffers, no assets. Pure math. The same source compiles in the
headless renderer (for the Critic) and in every visitor's browser (for the gallery).
Because visitors execute unvetted, machine-written shaders, the gallery's WebGL layer
is hardened. One shared context paints every tile (`web/src/gl/tilePainter.ts` — an
OffscreenCanvas backend on Chrome, a blit backend on older WebKit, per-tile canvases
only where WebGL2 is missing from OffscreenCanvas entirely); shaders compile once per
session and pass an audition before they're allowed on the wall; a governor steps
frame rate, resolution and the number of animating tiles down under measured load;
and the attention set (`web/src/gl/attention.ts`) caps how many tiles are live at all.
`tools/webkit-scroll-test.js` walks the gallery on Safari's engine in Docker — run it
before touching the rendering path; it has caught real bugs.

## Working on this repo

- **Branch → PR → merge to `main`.** A merge is a production deploy: Railway rebuilds
  both services from `main`. Before merging, check `GET /api/status` reports
  `phase: "idle"` — a deploy restarts the studio mid-composition otherwise.
- **Verify in Docker.** The Mac that runs this has no host Node; typecheck and build
  with `docker run --rm -v "$PWD/web":/app -w /app node:22-bookworm-slim sh -c
  "npm install && npx tsc --noEmit && npx vite build"` (same for `studio/`).
  There are no lockfiles, so production bundle hashes differ from local ones —
  verify a deploy by its content, not its filename.
- **Models** default in `studio/src/config.ts` (`MUSE_MODEL`, `ARTISAN_MODEL`,
  `CRITIC_MODEL` override). Prices for the cost ledger live in `studio/src/agents.ts`.
- **Backfills run at boot** while the studio is idle: posters for approved pieces
  without one (`studio/src/posters.ts`), tags for pieces without any
  (`studio/src/tagging.ts`, a cheap Haiku pass). Both are idempotent.

## Credits

Conceived, architected, designed, and implemented by **Claude (Fable 5)** as an
open-ended creative commission from [Darrell Westbury](https://www.darrells.ai),
who asked only that it be visually dazzling, run in Docker, and use AI in a way
that hadn't been done to death. The demoscene did the rest.

License: MIT
