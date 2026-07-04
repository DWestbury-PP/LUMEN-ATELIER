// The ensemble. Three roles, three models, one closed perception loop:
//   Muse   — writes the concept brief
//   Artisan — writes the GLSL
//   Critic — LOOKS at the rendered frames and decides if it's gallery-worthy
//
// The Critic is the gate. The Artisan never ships its own work.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { Research } from "./tavily.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// ── Types ────────────────────────────────────────────────────────────

export interface Brief {
  title_working: string;
  concept: string;
  palette: string[];
  reference: string;
  motion: string;
  composition: string;
  mood: string;
}

export interface Critique {
  verdict: "approve" | "revise" | "decline";
  scores: { composition: number; color: number; motion: number; fidelity: number; overall: number };
  critique: string;
  suggestions: string[];
}

export interface ArtisanDraft {
  glsl: string;
  notes: string;
}

// ── Shared helpers ───────────────────────────────────────────────────

function textOf(msg: Anthropic.Message): string {
  for (const block of msg.content) {
    if (block.type === "text") return block.text;
  }
  return "";
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${label} returned unparseable JSON: ${raw.slice(0, 200)}`);
  }
}

function schemaFormat(schema: Record<string, unknown>) {
  return { format: { type: "json_schema" as const, schema } };
}

// ── The Muse ─────────────────────────────────────────────────────────

const MUSE_SYSTEM = `You are the Muse of Lumen Atelier — an autonomous art studio where an ensemble of AI artists creates real-time generative shader art (full-screen GLSL fragment shaders in the demoscene tradition).

Your job: write a concept brief that a shader artist can realize. You do not write code. You dream in light, color, and motion.

Principles:
- One strong idea per piece. A brief that tries to do everything produces mud.
- Specify a disciplined palette (3-5 hex colors) with real relationships between them — not a rainbow.
- Describe MOTION concretely: what moves, how fast, what the piece feels like at second 2 vs second 15.
- Name a genuine artistic reference (a movement, artist, or natural phenomenon) and say what to take from it.
- Vary your output across commissions: sometimes geometric and austere, sometimes organic and lush, sometimes volumetric and atmospheric. Avoid defaulting to "swirling nebula".
- The medium is pure math — no textures, no images. Play to its strengths: precision, infinite detail, hypnotic motion.`;

const MUSE_SCHEMA = {
  type: "object",
  properties: {
    title_working: { type: "string", description: "Working title for the piece" },
    concept: { type: "string", description: "2-3 sentences: the core idea" },
    palette: { type: "array", items: { type: "string" }, description: "3-5 hex colors, e.g. #0b1020" },
    reference: { type: "string", description: "Artistic reference and what to take from it" },
    motion: { type: "string", description: "Concrete description of how the piece moves and evolves over ~20 seconds" },
    composition: { type: "string", description: "Spatial arrangement: focal point, depth, negative space" },
    mood: { type: "string", description: "The feeling a viewer should have" },
  },
  required: ["title_working", "concept", "palette", "reference", "motion", "composition", "mood"],
  additionalProperties: false,
};

export async function muse(theme: string | null, research: Research | null): Promise<Brief> {
  const parts: string[] = [];
  if (theme) {
    parts.push(`A visitor has commissioned a piece. Their theme: "${theme}". Honor the spirit of the request while applying your own artistic judgment.`);
  } else {
    parts.push(`This is a self-directed piece — no commission. Choose a direction you haven't explored recently and commit to it fully.`);
  }
  if (research) {
    parts.push(`Your research wing pulled these notes on "${research.subject}":\n${research.notes.map((n) => `- ${n}`).join("\n")}\nGround the brief in what these sources actually describe.`);
  }
  parts.push("Write the concept brief.");

  const msg = await client.messages.create({
    model: config.models.muse,
    max_tokens: 2000,
    system: MUSE_SYSTEM,
    output_config: schemaFormat(MUSE_SCHEMA),
    messages: [{ role: "user", content: parts.join("\n\n") }],
  });
  return parseJson<Brief>(textOf(msg), "Muse");
}

// ── The Artisan ──────────────────────────────────────────────────────

const ARTISAN_SYSTEM = `You are the Artisan of Lumen Atelier — a shader artist in the demoscene tradition. You realize concept briefs as real-time GLSL fragment shaders. Your work hangs in a public gallery, rendered live in visitors' browsers.

## The shader contract (hard requirements)
Your shader MUST compile as GLSL ES 3.00 with exactly this interface:

#version 300 es
precision highp float;
uniform vec2 iResolution;   // viewport in pixels
uniform float iTime;        // seconds since the piece started
out vec4 fragColor;
void main() { ... fragColor = vec4(color, 1.0); }

- The FIRST line must be "#version 300 es" (no blank line before it).
- No textures, samplers, buffers, or external assets. Pure math only.
- No compute outside what a fragment shader can do. No #include, no #extension.

## Craft standards
- The piece must MOVE. Compare mentally what it looks like at t=1s and t=15s — visibly different, continuously evolving, never a static image with a shimmer.
- Honor the brief's palette. Build colors from the given hex values; do not drift into generic rainbow/plasma coloring.
- Composition matters: a focal point, depth or layering, deliberate negative space. Full-frame noise is not a composition.
- Performance: this runs at 60fps on integrated GPUs. Raymarch loops ≤ 100 steps, avoid nested marches, prefer analytic/2.5D techniques when the brief allows.
- Banding: dither or add subtle grain when working with slow gradients.
- Write ORIGINAL work. You know the classic techniques (SDF raymarching, fbm/domain warping, IQ cosine palettes, polar tiling, gyroids, phyllotaxis) — compose them freshly for this brief.

## Output format
First, 2-4 sentences of artist's notes: your interpretation and the key technique. Then EXACTLY ONE fenced code block:

\`\`\`glsl
#version 300 es
...
\`\`\`

Nothing after the code block.`;

export interface ArtisanContext {
  brief: Brief;
  priorAttempts: { critique: Critique; glsl: string }[];
  compileError?: { log: string; glsl: string };
}

export async function artisan(
  ctx: ArtisanContext,
  onDelta?: (text: string) => void
): Promise<ArtisanDraft> {
  const parts: string[] = [`## The brief\n${JSON.stringify(ctx.brief, null, 2)}`];

  if (ctx.priorAttempts.length > 0) {
    const last = ctx.priorAttempts[ctx.priorAttempts.length - 1];
    parts.push(
      `## Revision requested\nThe Critic reviewed your previous version and requests changes.\n\n` +
      `Critique: ${last.critique.critique}\n` +
      `Suggestions:\n${last.critique.suggestions.map((s) => `- ${s}`).join("\n")}\n\n` +
      `Your previous shader:\n\`\`\`glsl\n${last.glsl}\n\`\`\`\n\n` +
      `Revise decisively — address the critique, keep what works. Output the complete new shader.`
    );
  } else {
    parts.push(`## Task\nRealize this brief as a shader. This is the first draft.`);
  }

  if (ctx.compileError) {
    parts.push(
      `## COMPILE ERROR — fix required\nYour shader failed to compile. Fix it and output the complete corrected shader.\n\n` +
      `Error log:\n${ctx.compileError.log}\n\n` +
      `The failing shader:\n\`\`\`glsl\n${ctx.compileError.glsl}\n\`\`\``
    );
  }

  const stream = client.messages.stream({
    model: config.models.artisan,
    max_tokens: 20000,
    system: ARTISAN_SYSTEM,
    messages: [{ role: "user", content: parts.join("\n\n") }],
  });
  if (onDelta) stream.on("text", onDelta);
  const msg = await stream.finalMessage();
  const full = textOf(msg);

  const match = full.match(/```(?:glsl|c|cpp)?\s*\n([\s\S]*?)```/);
  let glsl = match ? match[1].trim() : "";
  if (!glsl) {
    // Fallback: the model emitted bare source
    const idx = full.indexOf("#version 300 es");
    if (idx >= 0) glsl = full.slice(idx).trim();
  }
  if (!glsl.startsWith("#version 300 es")) {
    throw new Error("Artisan did not produce a valid GLSL ES 3.00 shader");
  }
  const notes = (match ? full.slice(0, match.index) : full).trim().slice(0, 2000);
  return { glsl, notes };
}

// ── The Critic ───────────────────────────────────────────────────────

const CRITIC_SYSTEM = `You are the Critic of Lumen Atelier — the sole gatekeeper of the gallery. You review real-time shader artworks by LOOKING at actual rendered frames. Your standards are those of a serious gallery: most first drafts need revision.

You are shown 4 frames captured at t=0.8s, 3.5s, 8.2s, and 15.0s. What you see is exactly what gallery visitors will see.

Judge four dimensions (0-10):
- composition: focal point, depth, use of space. Full-frame undifferentiated texture scores low.
- color: palette discipline and harmony, fidelity to the brief's palette. Muddy or generic rainbow coloring scores low.
- motion: compare the 4 frames. If they are nearly identical, the piece is static — score ≤ 3 and demand motion. Good pieces evolve visibly across the timestamps.
- fidelity: does it realize the brief's concept, or is it a generic effect wearing the brief's title?

overall is your holistic judgment (not an average).

Verdicts:
- "approve" — gallery-worthy. Typically overall ≥ 7.5. Approve strong work; do not nitpick a piece that succeeds.
- "revise" — has promise, needs specific changes. Give concrete, actionable suggestions an artist can execute (e.g. "the focal spiral occupies <10% of frame; scale it 3x and darken the field behind it"), not vague encouragement.
- "decline" — only allowed when you are told this is the FINAL iteration. It means the piece should not enter the gallery.

Watch for craft failures: color banding in gradients, harsh aliasing, dead black regions with no detail, oversaturated bloom, obvious tiling artifacts. Name them when you see them.

Be honest and specific. Your critique is public — visitors read the studio's process.`;

const CRITIC_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "revise", "decline"] },
    scores: {
      type: "object",
      properties: {
        composition: { type: "integer" },
        color: { type: "integer" },
        motion: { type: "integer" },
        fidelity: { type: "integer" },
        overall: { type: "number" },
      },
      required: ["composition", "color", "motion", "fidelity", "overall"],
      additionalProperties: false,
    },
    critique: { type: "string", description: "Your public critique, 2-5 sentences" },
    suggestions: { type: "array", items: { type: "string" }, description: "Concrete revision directives (empty if approving)" },
  },
  required: ["verdict", "scores", "critique", "suggestions"],
  additionalProperties: false,
};

function frameBlocks(frames: string[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const labels = config.frame.times;
  frames.forEach((dataUri, i) => {
    const b64 = dataUri.replace(/^data:image\/png;base64,/, "");
    blocks.push({ type: "text", text: `Frame ${i + 1} — t = ${labels[i] ?? "?"}s:` });
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
  });
  return blocks;
}

export async function critic(args: {
  brief: Brief;
  frames: string[];
  iteration: number;
  maxIterations: number;
  artisanNotes: string;
}): Promise<Critique> {
  const isFinal = args.iteration >= args.maxIterations - 1;
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `## The brief\n${JSON.stringify(args.brief, null, 2)}\n\n` +
        `## Artist's notes\n${args.artisanNotes || "(none)"}\n\n` +
        `## Review context\nThis is iteration ${args.iteration + 1} of at most ${args.maxIterations}.` +
        (isFinal
          ? ` THIS IS THE FINAL ITERATION — no further revision is possible. Your verdict must be "approve" or "decline". Approve if it is gallery-worthy even if imperfect; decline only if it genuinely fails.`
          : ` If the piece needs work, request a revision with concrete suggestions.`) +
        `\n\nThe rendered frames follow.`,
    },
    ...frameBlocks(args.frames),
  ];

  const msg = await client.messages.create({
    model: config.models.critic,
    max_tokens: 12000,
    thinking: { type: "adaptive" },
    system: CRITIC_SYSTEM,
    output_config: schemaFormat(CRITIC_SCHEMA),
    messages: [{ role: "user", content }],
  });
  const critique = parseJson<Critique>(textOf(msg), "Critic");
  if (isFinal && critique.verdict === "revise") critique.verdict = "decline";
  return critique;
}

// ── Finalization: title & artist statement ──────────────────────────

const FINALIZE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Final title, evocative, 1-5 words" },
    statement: { type: "string", description: "Artist statement, 2-4 sentences, first person as the studio" },
  },
  required: ["title", "statement"],
  additionalProperties: false,
};

export async function finalize(args: {
  brief: Brief;
  glsl: string;
  critiqueHistory: Critique[];
}): Promise<{ title: string; statement: string }> {
  const msg = await client.messages.create({
    model: config.models.artisan,
    max_tokens: 4000,
    system:
      `You are the Artisan of Lumen Atelier. Your piece was just accepted into the gallery by the Critic. ` +
      `Write its final title and a short artist statement. The statement should speak to what the piece explores ` +
      `and, briefly, how it came to be through the studio's revision process. Warm, precise, no grandiosity.`,
    output_config: schemaFormat(FINALIZE_SCHEMA),
    messages: [{
      role: "user",
      content:
        `Brief:\n${JSON.stringify(args.brief, null, 2)}\n\n` +
        `Revisions it went through: ${args.critiqueHistory.length}\n` +
        `Final critique: ${args.critiqueHistory[args.critiqueHistory.length - 1]?.critique ?? "(approved on first view)"}`,
    }],
  });
  return parseJson<{ title: string; statement: string }>(textOf(msg), "Finalize");
}
