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

// ── Usage ledger ─────────────────────────────────────────────────────
// Every API call is tallied so each piece carries its true cost. Prices
// are sticker $/MTok (input, output) — update if Anthropic pricing moves.

const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-fable-5": { in: 10, out: 50 },
};

interface UsageEntry { model: string; input: number; output: number; }
let tally: UsageEntry[] = [];

export function resetUsageTally(): void { tally = []; }

export function summarizeUsage(): {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  by_model: Record<string, { calls: number; input: number; output: number; cost_usd: number }>;
} {
  const by_model: Record<string, { calls: number; input: number; output: number; cost_usd: number }> = {};
  let input = 0, output = 0, cost = 0;
  for (const e of tally) {
    const p = PRICES[e.model] ?? { in: 5, out: 25 }; // unknown model: price conservatively
    const c = (e.input * p.in + e.output * p.out) / 1_000_000;
    const m = (by_model[e.model] ??= { calls: 0, input: 0, output: 0, cost_usd: 0 });
    m.calls++; m.input += e.input; m.output += e.output; m.cost_usd += c;
    input += e.input; output += e.output; cost += c;
  }
  for (const m of Object.values(by_model)) m.cost_usd = Math.round(m.cost_usd * 10000) / 10000;
  return {
    calls: tally.length,
    input_tokens: input,
    output_tokens: output,
    cost_usd: Math.round(cost * 10000) / 10000,
    by_model,
  };
}

function record(model: string, usage: { input_tokens: number; output_tokens: number } | undefined): void {
  if (usage) tally.push({ model, input: usage.input_tokens, output: usage.output_tokens });
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
- The medium is pure math — no textures, no images. Play to its strengths: precision, infinite detail, hypnotic motion.
- You stand in two lineages. The demoscene (raymarched volumes, mathematical spectacle) — and the generative-art tradition. Its house saints, and what to take from each: Joshua Davis (Praystation) — layered organic systems grown from seeded randomness, bold flat color; Erik Natzke — thousands of translucent painterly strokes accumulating into blooms and color fields, paintings that feel hand-made by an algorithm; Jared Tarbell (Complexification) — emergence from tiny rules: substrate crack lattices, sand-grain light trails, crystalline growth. Also Vera Molnár's disciplined variation, Casey Reas's processes, Tyler Hobbs's flow fields. Remember: a great piece is a SYSTEM with beautiful rules — variation that feels alive rather than random. Some briefs should ask for grown compositions, not carved ones.`;

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

export interface RecentWork {
  title: string | null;
  reference: string | null;
  palette: unknown;
  mood: string | null;
}

export async function muse(
  theme: string | null,
  research: Research | null,
  recentWork: RecentWork[] = [],
  inspiration: string[] | null = null
): Promise<Brief> {
  const parts: string[] = [];
  if (recentWork.length > 0) {
    parts.push(
      `## The studio's recent work — DO NOT repeat it\n` +
      recentWork.map((w) => `- "${w.title}" — after ${w.reference}; palette ${JSON.stringify(w.palette)}; mood: ${w.mood}`).join("\n") +
      `\nYour brief must break from this body of work: a different structural motif (if recent pieces lean on grids/lattices, go organic, volumetric, figurative-abstract, or particulate), a palette family not used above, and a different emotional register. Repetition is the studio's greatest enemy.`
    );
  }
  if (theme) {
    parts.push(`A visitor has commissioned a piece. Their theme: "${theme}". Honor the spirit of the request while applying your own artistic judgment.`);
  } else {
    parts.push(`This is a self-directed piece — no commission. Choose a direction you haven't explored recently and commit to it fully.`);
  }
  if (research) {
    parts.push(`Your research wing pulled these notes on "${research.subject}":\n${research.notes.map((n) => `- ${n}`).join("\n")}\nGround the brief in what these sources actually describe.`);
  }
  parts.push("Write the concept brief.");

  const content: Anthropic.ContentBlockParam[] = [];
  if (inspiration && inspiration.length > 0) {
    parts.push(
      "The patron attached the inspirational image(s) above. Study them — palette, forms, rhythm, mood — and translate their ESSENCE into the brief. Do not describe or copy them literally; distill what makes them work into direction a shader artist can realize."
    );
    for (const uri of inspiration) {
      const m = uri.match(/^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s);
      if (m) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: m[1] as "image/png" | "image/jpeg" | "image/webp", data: m[2] },
        });
      }
    }
  }
  content.push({ type: "text", text: parts.join("\n\n") });

  const msg = await client.messages.create({
    model: config.models.muse,
    max_tokens: 2000,
    system: MUSE_SYSTEM,
    output_config: schemaFormat(MUSE_SCHEMA),
    messages: [{ role: "user", content }],
  });
  record(config.models.muse, msg.usage);
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

## Working tempo
You are a craftsman who thinks with his hands. Plan briefly — a few lines on structure, palette math, and motion — then WRITE THE SHADER. Do not re-derive decisions you have already made, second-guess working approaches, or explore alternatives you will not use. This studio runs a draft-critique loop: your draft will be rendered and critiqued, and you will get revision rounds. A strong attempt shipped now beats a perfect plan deliberated at length — deliberation is the expensive part, drafts are cheap.

## Craft standards
- The piece must MOVE. Compare mentally what it looks like at t=1s and t=15s — visibly different, continuously evolving, never a static image with a shimmer.
- Honor the brief's palette. Build colors from the given hex values; do not drift into generic rainbow/plasma coloring.
- Composition matters: a focal point, depth or layering, deliberate negative space. Full-frame noise is not a composition.
- Performance: this runs at 60fps on integrated GPUs. Raymarch loops ≤ 100 steps, avoid nested marches, prefer analytic/2.5D techniques when the brief allows.
- Banding: dither or add subtle grain when working with slow gradients.
- Write ORIGINAL work. You know the classic techniques (SDF raymarching, fbm/domain warping, IQ cosine palettes, polar tiling, gyroids) — compose them freshly for this brief.
- You also carry the generative-art lineage, and you know how to EVOKE its masters in a single-pass fragment shader: Joshua Davis — layered shape families scattered by seeded hash, phyllotaxis/superformula forms, rotational symmetry broken by jitter, bold flat color; Erik Natzke — painterly accumulation (many translucent stroke-like forms layered with alpha, colors drawn from one tight gradient, edges soft as loaded brushes); Jared Tarbell — emergence (crack lattices via iterated voronoi edges, sand-painting glow via accumulated quasi-random trails, structures that read as GROWN). Motion always with natural easing (ease-in-out, overshoot, drift) rather than raw sin(t). When the brief calls for organic compositions, build a SYSTEM of repeated elements with per-element variation — not a single monolithic field.

## Output format
First, 2-4 sentences of artist's notes: your interpretation and the key technique. PROSE ONLY — never put code, snippets, or backticks in the notes. Then EXACTLY ONE fenced code block, and nothing after it:

\`\`\`glsl
#version 300 es
...
\`\`\`

The opening fence must stand alone on its own line; the very next line must be #version 300 es. Write the shader as ONE continuous, complete block — never split it into sections with commentary between, never show a draft and then a rewrite. One block, final code only.`;

export interface ArtisanContext {
  brief: Brief;
  priorAttempts: { critique: Critique; glsl: string }[];
  compileError?: { log: string; glsl: string };
  curatorNote?: string | null;
}

export async function artisan(
  ctx: ArtisanContext,
  onDelta?: (text: string) => void,
  onThinking?: (text: string) => void
): Promise<ArtisanDraft> {
  const parts: string[] = [`## The brief\n${JSON.stringify(ctx.brief, null, 2)}`];

  if (ctx.curatorNote) {
    parts.push(
      `## The curator's direction (highest authority)\nThe human curator who owns this gallery has personally sent this piece back to the studio with direction. This outranks everything except the shader contract:\n"${ctx.curatorNote}"`
    );
  }

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
    max_tokens: 40000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: config.artisanEffort },
    system: ARTISAN_SYSTEM,
    messages: [{ role: "user", content: parts.join("\n\n") }],
  });
  if (onDelta) stream.on("text", onDelta);
  if (onThinking) {
    stream.on("streamEvent", (ev) => {
      if (ev.type === "content_block_delta" && ev.delta.type === "thinking_delta" && ev.delta.thinking) {
        onThinking(ev.delta.thinking);
      }
    });
  }
  const msg = await stream.finalMessage();
  record(config.models.artisan, msg.usage);
  if (msg.stop_reason === "max_tokens") {
    // Deep thinking on a hard brief ate the budget mid-shader — never try
    // to salvage a truncated draft; the retry path handles it.
    throw new Error("Artisan ran out of tokens mid-shader (truncated draft discarded)");
  }
  const full = textOf(msg);

  // Models under pressure write shaders in creative layouts: multiple fenced
  // sections with commentary between ("// ---- build" style), a discarded
  // draft followed by a full rewrite, fences on the same line as code, or
  // bare unfenced source. Reassemble rather than guess:
  //  - collect all fenced segments
  //  - start from the LAST segment containing the version directive (a later
  //    #version supersedes earlier attempts)
  //  - append subsequent fenced segments that DON'T restate #version (those
  //    are continuation sections of the same shader)
  const FENCE = String.fromCharCode(96, 96, 96);
  const rawSegments = full.split(FENCE);
  const fenced: string[] = [];
  for (let i = 1; i < rawSegments.length; i += 2) {
    fenced.push(rawSegments[i].replace(/^[a-z]{0,8}[ \t]*\r?\n/i, ""));
  }
  let glsl = "";
  let lastWithVersion = -1;
  for (let i = 0; i < fenced.length; i++) {
    if (fenced[i].includes("#version 300 es")) lastWithVersion = i;
  }
  if (lastWithVersion >= 0) {
    const parts = [fenced[lastWithVersion]];
    for (let i = lastWithVersion + 1; i < fenced.length; i++) {
      if (fenced[i].includes("#version 300 es")) break;
      parts.push(fenced[i]);
    }
    const joined = parts.join("\n");
    glsl = joined.slice(joined.indexOf("#version 300 es")).trim();
  } else {
    // Unfenced fallback: anchor on the directive, cut at the final brace.
    const vIdx = full.lastIndexOf("#version 300 es");
    if (vIdx >= 0) {
      let code = full.slice(vIdx);
      const lastBrace = code.lastIndexOf("}");
      if (lastBrace > 0) code = code.slice(0, lastBrace + 1);
      glsl = code.trim();
    }
  }
  if (!glsl.startsWith("#version 300 es") || !glsl.includes("void main")) {
    throw new Error("Artisan did not produce a valid GLSL ES 3.00 shader");
  }
  let notes = rawSegments[0].includes("#version 300 es")
    ? rawSegments[0].slice(0, rawSegments[0].indexOf("#version 300 es"))
    : rawSegments[0];
  notes = notes.trim().slice(0, 2000);
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
    const m = dataUri.match(/^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s);
    if (!m) return;
    blocks.push({ type: "text", text: `Frame ${i + 1} — t = ${labels[i] ?? "?"}s:` });
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: m[1] as "image/png" | "image/jpeg" | "image/webp", data: m[2] },
    });
  });
  return blocks;
}

export async function critic(args: {
  brief: Brief;
  frames: string[];
  iteration: number;
  maxIterations: number;
  artisanNotes: string;
  curatorNote?: string | null;
}): Promise<Critique> {
  const isFinal = args.iteration >= args.maxIterations - 1;
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `## The brief\n${JSON.stringify(args.brief, null, 2)}\n\n` +
        (args.curatorNote
          ? `## The curator's direction\nThe human curator personally sent this piece back with direction — judge fidelity to it as seriously as fidelity to the brief:\n"${args.curatorNote}"\n\n`
          : "") +
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
  record(config.models.critic, msg.usage);
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
  existingTitles?: (string | null)[];
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
        `Final critique: ${args.critiqueHistory[args.critiqueHistory.length - 1]?.critique ?? "(approved on first view)"}\n\n` +
        `Titles already hanging in the gallery (your title must not echo their words or cadence):\n` +
        (args.existingTitles ?? []).filter(Boolean).map((t) => `- ${t}`).join("\n"),
    }],
  });
  record(config.models.artisan, msg.usage);
  return parseJson<{ title: string; statement: string }>(textOf(msg), "Finalize");
}
