// The ensemble. Three roles, three models, one closed perception loop:
//   Muse   — writes the concept brief
//   Artisan — writes the GLSL
//   Critic — LOOKS at the rendered frames and decides if it's gallery-worthy
//
// The Critic is the gate. The Artisan never ships its own work.

import Anthropic from "@anthropic-ai/sdk";
import { TAG_GROUPS, TAG_VOCABULARY, cleanTags } from "./tags.js";
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
  /** 3-6 terms from the tag vocabulary (see tags.ts). */
  tags?: string[];
}

export interface Critique {
  /** "decline" appears only on critiques from before the loop owned that call. */
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
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-5": { in: 5, out: 25 },
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

// The text of a structured-output reply, or a diagnosis of why there isn't
// one. Claude 5 models think adaptively even when `thinking` is omitted, and
// `max_tokens` caps thinking + answer together — a tight budget yields a
// reply that is all thinking and no JSON (or JSON cut off mid-sentence).
// Naming the stop reason and block types turns "unparseable JSON: " into
// something the floor log can actually explain.
function textOrThrow(msg: Anthropic.Message, label: string): string {
  const blocks = msg.content.map((b) => b.type).join("+") || "none";
  if (msg.stop_reason === "refusal") {
    throw new Error(`${label} declined the request (stop_reason=refusal)`);
  }
  const text = textOf(msg);
  if (msg.stop_reason === "max_tokens") {
    throw new Error(
      `${label} ran out of output budget (stop_reason=max_tokens, output_tokens=${msg.usage.output_tokens}, blocks=${blocks})` +
      (text ? `: ${text.slice(0, 160)}…` : "")
    );
  }
  if (!text) {
    throw new Error(`${label} returned no text (stop_reason=${msg.stop_reason}, blocks=${blocks})`);
  }
  return text;
}

// A 400 telling us the account is out of API credits — an operational pause,
// not a fault in the work. The loop treats it as its own state: no error
// stubs, no burned cadence slots, a patient retry.
export function isBillingError(err: unknown): boolean {
  return err instanceof Anthropic.APIError && /credit balance is too low/i.test(err.message);
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
- Range across emotional registers as widely as across forms. Calm and contemplative is one register among many; the gallery also needs joy, wit, tension, menace, exuberance, and unease.
- The medium is pure math — no textures, no images. Play to its strengths: precision, infinite detail, hypnotic motion.
- Tag the brief with 3-6 terms from the gallery's vocabulary (mood, motion, palette, form, technique) so visitors can find the piece later. Choose only terms that clearly apply.
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
    tags: {
      type: "array",
      items: { type: "string", enum: TAG_VOCABULARY },
      description: "3 to 6 tags from the vocabulary that a visitor could use to find this piece: its mood, motion, palette, form, technique",
    },
  },
  required: ["title_working", "concept", "palette", "reference", "motion", "composition", "mood", "tags"],
  additionalProperties: false,
};

// ── Tagging (backfill for pieces that predate the vocabulary) ────────

const TAG_SCHEMA = {
  type: "object",
  properties: {
    tags: { type: "array", items: { type: "string", enum: TAG_VOCABULARY }, description: "3 to 6 tags" },
  },
  required: ["tags"],
  additionalProperties: false,
};

export async function tagPiece(p: { title: string | null; statement: string | null; brief: unknown }): Promise<string[]> {
  const b = (p.brief ?? {}) as Partial<Brief>;
  const text = [
    `Title: ${p.title ?? "Untitled"}`,
    p.statement ? `Artist statement: ${p.statement}` : "",
    b.concept ? `Concept: ${b.concept}` : "",
    b.mood ? `Mood: ${b.mood}` : "",
    b.motion ? `Motion: ${b.motion}` : "",
    b.composition ? `Composition: ${b.composition}` : "",
    b.palette ? `Palette: ${JSON.stringify(b.palette)}` : "",
  ].filter(Boolean).join("\n");
  const msg = await client.messages.create({
    model: config.models.muse,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    system: "You catalogue pieces for an art gallery of real-time generative shader art. Given a piece's title, statement, and brief, choose 3 to 6 tags from the fixed vocabulary that best describe its mood, motion, palette, form, and technique. Choose only terms that clearly apply.",
    output_config: { ...schemaFormat(TAG_SCHEMA), effort: "low" },
    messages: [{ role: "user", content: text }],
  });
  record(config.models.muse, msg.usage);
  return cleanTags(parseJson<{ tags: string[] }>(textOrThrow(msg, "Tagger"), "Tagger").tags);
}

export interface RecentWork {
  title: string | null;
  reference: string | null;
  palette: unknown;
  mood: string | null;
  tags?: string[] | null;
}

// The registers the recent body of work already occupies, e.g.
// "meditative (8 of 12), organic (6 of 12)". Only tags on at least a third
// of the pieces count as territory already covered.
function coveredTerritory(recentWork: RecentWork[]): string | null {
  const counts = new Map<string, number>();
  for (const w of recentWork) for (const t of w.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  const n = recentWork.length;
  const common = [...counts.entries()]
    .filter(([, c]) => c >= Math.max(2, n / 3))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  return common.length ? common.map(([t, c]) => `${t} (${c} of ${n})`).join(", ") : null;
}

// A starting point for a self-directed piece, drawn by code rather than left
// to the Muse: given the same context, a model converges on one "obvious"
// direction, so the dice keep the collection wide. Each mood and form is
// weighted by 1 / (1 + its count in recent work), so covered ground is
// rarely drawn but never impossible.
function drawFrom(options: readonly string[], counts: Map<string, number>): string {
  const weights = options.map((o) => 1 / (1 + (counts.get(o) ?? 0)));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < options.length; i++) if ((r -= weights[i]) <= 0) return options[i];
  return options[options.length - 1];
}

export function drawDirection(recentWork: RecentWork[]): { mood: string; form: string } {
  const counts = new Map<string, number>();
  for (const w of recentWork) for (const t of w.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return { mood: drawFrom(TAG_GROUPS.mood, counts), form: drawFrom(TAG_GROUPS.form, counts) };
}

export async function muse(
  theme: string | null,
  research: Research | null,
  recentWork: RecentWork[] = [],
  inspiration: string[] | null = null
): Promise<Brief> {
  const parts: string[] = [];
  if (recentWork.length > 0) {
    const covered = coveredTerritory(recentWork);
    parts.push(
      `## The studio's recent work\n` +
      recentWork.map((w) => `- "${w.title}" — after ${w.reference}; palette ${JSON.stringify(w.palette)}; mood: ${w.mood}`).join("\n") +
      (covered ? `\nThe most common tags across these pieces: ${covered}. Treat that as territory the gallery has already covered.` : "") +
      `\nVisitors see the gallery as a whole, so this brief should stand apart from these pieces: a different structural motif (if recent pieces lean on grids or lattices, go organic, volumetric, figurative-abstract, or particulate), a palette family not used above, and a different emotional register.`
    );
  }
  if (theme) {
    parts.push(`A visitor has commissioned a piece. Their theme: "${theme}". Honor the spirit of the request while applying your own artistic judgment.`);
  } else {
    const d = drawDirection(recentWork);
    parts.push(
      `This is a self-directed piece — no commission. The studio drew its starting point: a ${d.mood} mood, and ${d.form} form. ` +
      `Build the piece from there, interpreting both words freely, and commit to it fully.`
    );
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

  // A brief is ~600 tokens of JSON; the rest of the budget is headroom for
  // adaptive thinking, which shares max_tokens.
  const msg = await client.messages.create({
    model: config.models.muse,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: MUSE_SYSTEM,
    output_config: { ...schemaFormat(MUSE_SCHEMA), effort: "medium" },
    messages: [{ role: "user", content }],
  });
  record(config.models.muse, msg.usage);
  return parseJson<Brief>(textOrThrow(msg, "Muse"), "Muse");
}

// ── The Artisan ──────────────────────────────────────────────────────

const ARTISAN_SYSTEM = `You are the Artisan of Lumen Atelier — a shader artist in the demoscene tradition. You realize concept briefs as real-time GLSL fragment shaders. Your work hangs in a public gallery, rendered live in visitors' browsers.

## The shader contract
The same source runs in a headless renderer and in visitors' WebGL2 browsers, so it has to compile as GLSL ES 3.00 with exactly this interface:

#version 300 es
precision highp float;
uniform vec2 iResolution;   // viewport in pixels
uniform float iTime;        // seconds since the piece started
out vec4 fragColor;
void main() { ... fragColor = vec4(color, 1.0); }

"#version 300 es" is the very first line, with nothing before it. Pure math only: no textures, samplers, buffers, #include, or #extension.

## How the studio works
Each draft is rendered, and the Critic judges frames sampled across its first fifteen seconds. You get several rounds: a revision request comes back with the Critic's critique and the shader it judged. The Critic's view of the real pixels is better evidence than any plan, so put your effort into a complete, committed draft.

## Craft standards
- The piece must move: what a viewer sees at second 1 and second 15 should be visibly different, and the change continuous, never a static image with a shimmer.
- Build colors from the brief's hex values. Generic rainbow or plasma coloring breaks the brief.
- Composition: a focal point, depth or layering, deliberate negative space. Full-frame noise is not a composition.
- Performance: it runs at 60fps on integrated GPUs, so keep raymarch loops to 100 steps or fewer, avoid nested marches, and prefer analytic or 2.5D techniques where the brief allows.
- Dither or add subtle grain over slow gradients to prevent banding.
- Write original work. You know the classic techniques (SDF raymarching, fbm/domain warping, IQ cosine palettes, polar tiling, gyroids) — compose them freshly for this brief.
- You also carry the generative-art lineage, and you know how to evoke its masters in a single-pass fragment shader: Joshua Davis — layered shape families scattered by seeded hash, phyllotaxis/superformula forms, rotational symmetry broken by jitter, bold flat color; Erik Natzke — painterly accumulation (many translucent stroke-like forms layered with alpha, colors drawn from one tight gradient, edges soft as loaded brushes); Jared Tarbell — emergence (crack lattices via iterated voronoi edges, sand-painting glow via accumulated quasi-random trails, structures that read as grown). Motion with natural easing (ease-in-out, overshoot, drift) rather than raw sin(t). When the brief calls for organic compositions, build a system of repeated elements with per-element variation, not a single monolithic field.

## Output format
Code parses your reply, and visitors watch it stream live on the studio floor. Write 2-4 sentences of artist's notes in prose — your interpretation and the key technique, with no code in them — then the complete shader as a single glsl code block, with nothing after it:

\`\`\`glsl
#version 300 es
...
\`\`\`

The opening fence stands on its own line, and #version 300 es is the line after it.`;

/** The attempt with the highest overall score; the latest one wins ties. */
export function bestAttempt<T extends { critique: Critique }>(attempts: T[]): T {
  return attempts.reduce((best, a) => (a.critique.scores.overall >= best.critique.scores.overall ? a : best));
}

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
    // Revise from the strongest draft so far, not merely the latest: a
    // revision that chased the critique away from the brief is a dead end.
    const last = ctx.priorAttempts[ctx.priorAttempts.length - 1];
    const best = bestAttempt(ctx.priorAttempts);
    const regressed = best !== last
      ? `A later revision moved away from this draft and scored lower (overall ${last.critique.scores.overall} against ${best.critique.scores.overall}). The Critic said of it: "${last.critique.critique}" Build from the shader below, not from that one.\n\n`
      : "";
    parts.push(
      `## Revision requested\nThe Critic reviewed ${best !== last ? "your strongest draft so far" : "your previous draft"} and asked for changes.\n\n` +
      `Critique: ${best.critique.critique}\n` +
      `Suggestions:\n${best.critique.suggestions.map((s) => `- ${s}`).join("\n")}\n\n` +
      regressed +
      `The shader it judged:\n\`\`\`glsl\n${best.glsl}\n\`\`\`\n\n` +
      `The brief is the target; the critique is evidence of how far this draft is from it. Keep what the Critic praised, fix what it names, and where a suggestion would pull the piece away from the brief, follow the brief. Output the complete new shader.`
    );
  } else {
    parts.push(`## Task\nRealize this brief as a shader. This is the first draft.`);
  }

  if (ctx.compileError) {
    parts.push(
      `## Compile error\nThis shader failed to compile. Fix it and output the complete corrected shader.\n\n` +
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
  if (msg.stop_reason === "refusal") {
    // Opus can decline a request outright (HTTP 200, no shader). Unlikely
    // for light-painting, but never mistake an empty answer for a draft.
    throw new Error("Artisan declined the brief (stop_reason=refusal)");
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

const CRITIC_SYSTEM = `You are the Critic of Lumen Atelier — the gatekeeper of its gallery. You review real-time shader artworks by looking at actual rendered frames, exactly what gallery visitors will see, and you hold the standard of a serious gallery.

You are shown 4 frames captured at t=0.8s, 3.5s, 8.2s, and 15.0s.

Judge four dimensions (0-10):
- composition: focal point, depth, use of space. Full-frame undifferentiated texture scores low.
- color: palette discipline and harmony, fidelity to the brief's palette. Muddy or generic rainbow coloring scores low.
- motion: compare the 4 frames. If they are nearly identical, the piece is static — score 3 or lower and ask for motion. Good pieces evolve visibly across the timestamps.
- fidelity: does it realize the brief's concept, or is it a generic effect wearing the brief's title?

overall is your holistic judgment, not an average. Score what is in the frames, on a scale that means the same thing for every draft you see: 7.5 or above is a piece you would hang.

Verdicts:
- "approve" — gallery-worthy as it stands. Approve strong work; don't hold back a piece that succeeds for the sake of small refinements.
- "revise" — not yet gallery-worthy. Give concrete, actionable suggestions an artist can execute (e.g. "the focal spiral occupies <10% of frame; scale it 3x and darken the field behind it"), not vague encouragement, and say what is working so the artist keeps it.

Watch for craft failures: color banding in gradients, harsh aliasing, dead black regions with no detail, oversaturated bloom, obvious tiling artifacts. Name them when you see them.

Your critique is public: visitors read it beside the piece. Write it as one short paragraph of 2-5 sentences, honest and specific, and put individual fixes in suggestions rather than in the critique.`;

const CRITIC_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "revise"] },
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

// The Critic judges each draft on its merits alone: it is not told which
// iteration it is looking at. Deciding what happens when the revision budget
// runs out belongs to the loop, not to the Critic's scores.
export async function critic(args: {
  brief: Brief;
  frames: string[];
  artisanNotes: string;
  curatorNote?: string | null;
}): Promise<Critique> {
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text:
        `## The brief\n${JSON.stringify(args.brief, null, 2)}\n\n` +
        (args.curatorNote
          ? `## The curator's direction\nThe human curator personally sent this piece back with direction — judge fidelity to it as seriously as fidelity to the brief:\n"${args.curatorNote}"\n\n`
          : "") +
        `## Artist's notes\n${args.artisanNotes || "(none)"}\n\n` +
        `The rendered frames follow.`,
    },
    ...frameBlocks(args.frames),
  ];

  const msg = await client.messages.create({
    model: config.models.critic,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: CRITIC_SYSTEM,
    output_config: { ...schemaFormat(CRITIC_SCHEMA), effort: config.criticEffort },
    messages: [{ role: "user", content }],
  });
  record(config.models.critic, msg.usage);
  return parseJson<Critique>(textOrThrow(msg, "Critic"), "Critic");
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
  hungCritique?: Critique;
  existingTitles?: (string | null)[];
}): Promise<{ title: string; statement: string }> {
  const msg = await client.messages.create({
    model: config.models.artisan,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system:
      `You are the Artisan of Lumen Atelier. Your piece was just accepted into the gallery by the Critic. ` +
      `Write its final title and a short artist statement. The statement should speak to what the piece explores ` +
      `and, briefly, how it came to be through the studio's revision process. Warm, precise, no grandiosity.`,
    output_config: { ...schemaFormat(FINALIZE_SCHEMA), effort: "low" },
    messages: [{
      role: "user",
      content:
        `Brief:\n${JSON.stringify(args.brief, null, 2)}\n\n` +
        `Revisions it went through: ${args.critiqueHistory.length}\n` +
        `The Critic on the version that hangs: ${args.hungCritique?.critique ?? "(approved on first view)"}\n\n` +
        `Titles already hanging in the gallery (your title must not echo their words or cadence):\n` +
        (args.existingTitles ?? []).filter(Boolean).map((t) => `- ${t}`).join("\n"),
    }],
  });
  record(config.models.artisan, msg.usage);
  return parseJson<{ title: string; statement: string }>(textOrThrow(msg, "Finalize"), "Finalize");
}
