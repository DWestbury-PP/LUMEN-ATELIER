// The creative loop. One piece at a time:
//   claim → Muse brief → [Artisan draft → render → Critic verdict]* → gallery
//
// Compile errors bounce straight back to the Artisan (agentic self-repair);
// aesthetic verdicts come from the Critic, who actually looks at the frames.

import { config, hasKey } from "./config.js";
import { q, type PieceRow } from "./db.js";
import { emitStudio } from "./bus.js";
import { renderShader } from "./renderer.js";
import { maybeResearch } from "./tavily.js";
import { muse, artisan, critic, finalize, type Brief, type Critique } from "./agents.js";

const COMPILE_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StudioState {
  running: boolean;
  hasKey: boolean;
  currentPieceId: number | null;
  phase: string; // idle | brief | drafting | rendering | critique | finalizing
}

export const state: StudioState = {
  running: false,
  hasKey: hasKey(),
  currentPieceId: null,
  phase: "idle",
};

function setPhase(phase: string, pieceId: number | null = state.currentPieceId) {
  state.phase = phase;
  emitStudio("studio.phase", pieceId, { phase });
}

async function composePiece(piece: PieceRow): Promise<void> {
  const id = piece.id;
  state.currentPieceId = id;
  await q.setStatus(id, "composing");
  emitStudio("piece.started", id, { theme: piece.theme, patron: piece.patron });

  // 1 — The Muse writes the brief (optionally grounded in research)
  setPhase("brief");
  const research = await maybeResearch(piece.theme);
  if (research) emitStudio("muse.research", id, { subject: research.subject });
  const brief: Brief = await muse(piece.theme, research);
  await q.setBrief(id, brief);
  emitStudio("muse.brief", id, { brief });

  // 2 — Draft / render / critique loop
  const attempts: { critique: Critique; glsl: string }[] = [];
  const critiqueHistory: Critique[] = [];
  let approvedGlsl: string | null = null;
  let iterationsUsed = 0;

  for (let iter = 0; iter < config.maxIterations; iter++) {
    iterationsUsed = iter + 1;
    setPhase("drafting");
    emitStudio("artisan.started", id, { iteration: iter });

    // Draft, with compile-repair inner loop
    let draft = await artisan(
      { brief, priorAttempts: attempts },
      (text) => emitStudio("artisan.delta", id, { text })
    );
    emitStudio("artisan.draft", id, { iteration: iter, notes: draft.notes, glsl: draft.glsl });

    setPhase("rendering");
    let render = await renderShader(draft.glsl);
    let repairs = 0;
    while (!render.ok && (render.stage === "compile" || render.stage === "link") && repairs < COMPILE_RETRIES) {
      repairs++;
      emitStudio("artisan.compile_error", id, { iteration: iter, attempt: repairs, log: (render.log || "").slice(0, 1500) });
      draft = await artisan(
        { brief, priorAttempts: attempts, compileError: { log: render.log || "unknown", glsl: draft.glsl } },
        (text) => emitStudio("artisan.delta", id, { text })
      );
      emitStudio("artisan.draft", id, { iteration: iter, notes: draft.notes, glsl: draft.glsl, repaired: true });
      render = await renderShader(draft.glsl);
    }

    if (!render.ok || !render.frames) {
      await q.insertIteration(id, iter, {
        glsl: draft.glsl, artisanNotes: draft.notes, compileOk: false,
        compileLog: render.log || "render failed", frames: null, critique: null,
      });
      emitStudio("piece.render_failed", id, { iteration: iter, log: (render.log || "").slice(0, 1500) });
      continue; // try a fresh iteration if budget remains
    }

    emitStudio("iteration.rendered", id, { iteration: iter, frames: render.frames, glsl: draft.glsl });

    // 3 — The Critic looks
    setPhase("critique");
    const verdict = await critic({
      brief,
      frames: render.frames,
      iteration: iter,
      maxIterations: config.maxIterations,
      artisanNotes: draft.notes,
    });
    critiqueHistory.push(verdict);
    await q.insertIteration(id, iter, {
      glsl: draft.glsl, artisanNotes: draft.notes, compileOk: true,
      compileLog: null, frames: render.frames, critique: verdict,
    });
    emitStudio("critic.verdict", id, { iteration: iter, verdict });

    if (verdict.verdict === "approve") {
      approvedGlsl = draft.glsl;
      break;
    }
    if (verdict.verdict === "decline") break;
    attempts.push({ critique: verdict, glsl: draft.glsl });
  }

  // 4 — Finalize or decline
  if (approvedGlsl) {
    setPhase("finalizing");
    const { title, statement } = await finalize({ brief, glsl: approvedGlsl, critiqueHistory });
    await q.approvePiece(id, approvedGlsl, title, statement, iterationsUsed);
    emitStudio("piece.approved", id, { title, statement, iterations: iterationsUsed });
  } else {
    await q.declinePiece(id, iterationsUsed);
    emitStudio("piece.declined", id, { iterations: iterationsUsed });
  }
}

async function maybeAutoCreate(): Promise<PieceRow | null> {
  if (!config.autoCreate) return null;
  const last = await q.lastAutoCreatedAt();
  const due = last === null || Date.now() - last.getTime() > config.autoCreateIntervalMin * 60_000;
  if (!due) return null;
  const piece = await q.createPiece(null, null);
  emitStudio("studio.self_commission", piece.id, {});
  return piece;
}

export async function studioLoop(): Promise<void> {
  state.running = true;
  if (!hasKey()) {
    emitStudio("studio.no_key", null, {
      message: "No ANTHROPIC_API_KEY configured — the ensemble is asleep. Gallery serves existing pieces only.",
    });
  }
  for (;;) {
    try {
      if (!hasKey()) { await sleep(30_000); continue; }
      let piece = await q.nextQueued();
      if (!piece) piece = await maybeAutoCreate();
      if (!piece) {
        if (state.phase !== "idle") setPhase("idle", null);
        state.currentPieceId = null;
        await sleep(10_000);
        continue;
      }
      await composePiece(piece);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitStudio("studio.error", state.currentPieceId, { message: msg.slice(0, 500) });
      if (state.currentPieceId) {
        await q.setStatus(state.currentPieceId, "error").catch(() => {});
      }
      await sleep(20_000); // back off (rate limits, transient API errors)
    } finally {
      state.currentPieceId = null;
      setPhase("idle", null);
    }
    await sleep(5_000);
  }
}
