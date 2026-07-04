<div align="center">

# ◈ Lumen Atelier

### An autonomous art studio where the artist can see its own work

Three Claude models run a working atelier: the **Muse** writes a concept brief, the
**Artisan** writes a real-time GLSL shader, and the **Critic** *looks at the actual
rendered frames* — approving, or sending the work back with notes — until the piece
earns its place in the gallery.

`Claude Haiku · Sonnet · Opus` · `WebGL2 / GLSL ES 3.00` · `React` · `Node/TS` · `Postgres` · `Docker Compose`

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

## The ensemble

| Role | Default model | Job |
|---|---|---|
| **The Muse** | `claude-haiku-4-5` | Writes the concept brief: one idea, a disciplined palette, concrete motion. Optionally grounds itself in real art-history research via Tavily. |
| **The Artisan** | `claude-sonnet-5` | Realizes the brief as a GLSL ES 3.00 shader, in the demoscene tradition. Streams its work token-by-token to the live studio floor. Repairs its own compile errors. |
| **The Critic** | `claude-opus-4-8` | The gate. Examines 4 rendered frames (t = 0.8s → 15s), scores composition / color / motion / brief-fidelity, and issues a verdict: approve, revise with concrete notes, or — on the final iteration — decline. |

The models are configurable via `.env`; recast the ensemble however you like.

## What's in the gallery

- **The Collection** — approved pieces, rendered live in WebGL2.
- **Piece pages** — title, artist statement, the Muse's brief, and the full creative
  process: every draft viewable *live*, with the Critic's scores and notes.
- **The Studio Floor** — a live view of the piece being made right now: the Artisan's
  code streaming in, captured frames, verdicts as they land.
- **Commissions** — visitors give the studio a theme; the ensemble takes it from there.
- **Exhibit mode** — fullscreen ambient display, pieces cross-fading. Point a spare
  monitor at `/exhibit`.

## Running it

Requirements: Docker with Compose. Nothing else touches the host.

```bash
cp .env.example .env    # add your ANTHROPIC_API_KEY
docker compose up -d --build
open http://localhost:7777
```

Without an API key the ensemble sleeps, but the gallery still opens with three
hand-written **calibration pieces** so the pipeline is visible end-to-end.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  web (nginx + React + WebGL2)                :7777          │
│  gallery · piece pages · studio floor (SSE) · exhibit       │
└──────────────┬──────────────────────────────────────────────┘
               │ /api (REST + SSE)
┌──────────────▼──────────────────────────────────────────────┐
│  studio (Node/TS)                                           │
│  the creative loop: Muse → Artisan → render → Critic        │
│  commissions API · live event bus · Postgres persistence    │
└───────┬───────────────────────────────┬─────────────────────┘
        │ POST /render                  │ SQL
┌───────▼────────────────────┐  ┌───────▼─────────┐
│  renderer                  │  │  db (Postgres)  │
│  headless Chromium +       │  │  pieces ·       │
│  SwiftShader WebGL2 —      │  │  iterations ·   │
│  the studio's *eyes*       │  │  events         │
└────────────────────────────┘  └─────────────────┘
```

The renderer needs no GPU — SwiftShader rasterizes the shader in software, which is
exactly what makes the perception loop portable: it runs identically on a laptop, a
Mac mini, or a cloud box.

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

## Credits

Conceived, architected, designed, and implemented by **Claude (Fable 5)** as an
open-ended creative commission from [Darrell Westbury](https://www.darrells.ai),
who asked only that it be visually dazzling, run in Docker, and use AI in a way
that hadn't been done to death. The demoscene did the rest.

License: MIT
