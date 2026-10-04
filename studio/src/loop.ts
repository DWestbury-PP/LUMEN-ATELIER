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
import { muse, artisan, critic, finalize, bestAttempt, isBillingError, resetUsageTally, summarizeUsage, type Brief, type Critique } from "./agents.js";
import { ensurePoster } from "./posters.js";
import { cleanTags } from "./tags.js";

const COMPILE_RETRIES = 3;
// How long the studio rests after learning the API account is out of credits.
const BILLING_RETRY_MIN = config.billingRetryMin;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StudioState {
  running: boolean;
  hasKey: boolean;
  currentPieceId: number | null;
  phase: string; // idle | brief | drafting | rendering | critique | finalizing
  phaseSince: string;
  /** Epoch ms until which the loop rests because the API account is out of credits. */
  billingHoldUntil: number | null;
  /** The curator paused new pieces. Persisted in studio_settings. */
  paused: boolean;
  /** 24h spend has reached config.dailySpendCap; no new piece starts. */
  spendHold: boolean;
}

export const state: StudioState = {
  running: false,
  hasKey: hasKey(),
  currentPieceId: null,
  phase: "idle",
  phaseSince: new Date().toISOString(),
  billingHoldUntil: null,
  paused: false,
  spendHold: false,
};

/** Pause or resume new pieces. The piece in progress, if any, finishes. */
export async function setPaused(paused: boolean): Promise<void> {
  await q.setSetting("paused", paused);
  state.paused = paused;
  emitStudio(paused ? "studio.paused" : "studio.resumed", null, {});
}

type Ledger = ReturnType<typeof summarizeUsage>;

// A piece's ledger accumulates across every run it gets: resumes after a
// restart or a billing outage, and curator send-backs.
function mergeLedgers(prior: Ledger | null, run: Ledger): Ledger {
  if (!prior || typeof prior.cost_usd !== "number") return run;
  const by_model = { ...(prior.by_model ?? {}) };
  for (const [m, v] of Object.entries(run.by_model)) {
    const p = by_model[m] ?? { calls: 0, input: 0, output: 0, cost_usd: 0 };
    by_model[m] = {
      calls: p.calls + v.calls, input: p.input + v.input, output: p.output + v.output,
      cost_usd: Math.round((p.cost_usd + v.cost_usd) * 10000) / 10000,
    };
  }
  return {
    calls: prior.calls + run.calls,
    input_tokens: prior.input_tokens + run.input_tokens,
    output_tokens: prior.output_tokens + run.output_tokens,
    cost_usd: Math.round((prior.cost_usd + run.cost_usd) * 10000) / 10000,
    by_model,
  };
}

function setPhase(phase: string, pieceId: number | null = state.currentPieceId) {
  state.phase = phase;
  state.phaseSince = new Date().toISOString();
  emitStudio("studio.phase", pieceId, { phase, since: state.phaseSince });
}

// Every call this run makes is recorded on the piece after each round and
// however the run ends — errors and billing outages included — so the
// 24h spend the cap reads never misses money that was actually spent.
async function composePiece(piece: PieceRow): Promise<void> {
  resetUsageTally();
  const prior = (piece.ledger ?? null) as Ledger | null;
  const persist = async (): Promise<Ledger> => {
    const ledger = mergeLedgers(prior, summarizeUsage());
    await q.setPieceLedger(piece.id, ledger).catch(() => {});
    return ledger;
  };
  try {
    await composeRun(piece, persist);
  } finally {
    await persist();
  }
}

async function composeRun(piece: PieceRow, persist: () => Promise<Ledger>): Promise<void> {
  const id = piece.id;
  state.currentPieceId = id;
  await q.setStatus(id, "composing");
  emitStudio("piece.started", id, { theme: piece.theme, patron: piece.patron });

  const curatorNote = (piece as PieceRow & { curator_note?: string | null }).curator_note ?? null;

  // 1 — The brief: written by the Muse, or reused when the curator sends a
  // finished piece back for further iteration.
  let brief: Brief;
  if (piece.brief) {
    brief = piece.brief as Brief;
    if (curatorNote) emitStudio("curator.direction", id, { note: curatorNote });
  } else {
    setPhase("brief");
    const recentSubjects = await q.recentResearchSubjects(10).catch(() => []);
    const research = await maybeResearch(piece.theme, recentSubjects);
    if (research) emitStudio("muse.research", id, { subject: research.subject });
    const recentWork = await q.recentApprovedSummaries(12).catch(() => []);
    const inspiration = (piece as PieceRow & { inspiration?: string[] | null }).inspiration ?? null;
    brief = await muse(piece.theme, research, recentWork, inspiration);
    await q.setBrief(id, brief, cleanTags(brief.tags));
    emitStudio("muse.brief", id, { brief });
  }

  // 2 — Draft / render / critique loop
  // The round allowance. A piece may reach `budget` drafts in total; the
  // current allowance began at `windowStart`. A restart or billing resume
  // gets only what is left of it, so a crash can never buy more rounds. A
  // curator send-back raises the budget (q.curatorReiterate).
  const attempts: { critique: Critique; glsl: string; idx?: number }[] = [];
  const critiqueHistory: Critique[] = [];
  const idxBase = await q.nextIterationIdx(id);
  const budget = piece.round_budget ?? config.maxIterations;
  const windowStart = Math.max(0, budget - config.maxIterations);
  const rounds = Math.max(0, budget - idxBase);
  for (const it of await q.critiquedIterationsFrom(id, windowStart)) {
    const c = it.critique as Critique;
    attempts.push({ critique: c, glsl: it.glsl, idx: it.idx });
    critiqueHistory.push(c);
  }
  if (attempts.length === 0 && idxBase > 0) {
    // A fresh allowance after a send-back: the last judged draft is the
    // Artisan's starting point, but it was already decided, so it is not
    // a candidate to hang.
    const last = await q.lastCritiquedIteration(id);
    if (last?.critique) attempts.push({ critique: last.critique as Critique, glsl: last.glsl });
  }
  if (idxBase > windowStart) emitStudio("piece.resumed", id, { drafts: idxBase - windowStart, remaining: rounds });
  let approvedGlsl: string | null = null;
  let hungCritique: Critique | undefined;
  let iterationsUsed = idxBase - windowStart;
  let parked = false;

  for (let iter = 0; iter < rounds; iter++) {
    iterationsUsed = idxBase - windowStart + iter + 1;
    setPhase("drafting");
    emitStudio("artisan.started", id, { iteration: idxBase + iter });

    // Draft, with compile-repair inner loop. A malformed response (no valid
    // shader block) gets one fresh retry before it can fail the piece.
    const draftOnce = () => artisan(
      { brief, priorAttempts: attempts, curatorNote },
      (text) => emitStudio("artisan.delta", id, { text }),
      (text) => emitStudio("artisan.thinking", id, { text })
    );
    let draft: Awaited<ReturnType<typeof artisan>>;
    try {
      draft = await draftOnce();
    } catch (err) {
      emitStudio("artisan.malformed", id, { message: err instanceof Error ? err.message : String(err) });
      draft = await draftOnce();
    }
    emitStudio("artisan.draft", id, { iteration: idxBase + iter, notes: draft.notes, glsl: draft.glsl });

    setPhase("rendering");
    let render = await renderShader(draft.glsl);
    let repairs = 0;
    while (!render.ok && (render.stage === "compile" || render.stage === "link") && repairs < COMPILE_RETRIES) {
      repairs++;
      emitStudio("artisan.compile_error", id, { iteration: idxBase + iter, attempt: repairs, log: (render.log || "").slice(0, 1500) });
      draft = await artisan(
        { brief, priorAttempts: attempts, curatorNote, compileError: { log: render.log || "unknown", glsl: draft.glsl } },
        (text) => emitStudio("artisan.delta", id, { text }),
        (text) => emitStudio("artisan.thinking", id, { text })
      );
      emitStudio("artisan.draft", id, { iteration: idxBase + iter, notes: draft.notes, glsl: draft.glsl, repaired: true });
      render = await renderShader(draft.glsl);
    }

    if (!render.ok || !render.frames) {
      await q.insertIteration(id, idxBase + iter, {
        glsl: draft.glsl, artisanNotes: draft.notes, compileOk: false,
        compileLog: render.log || "render failed", frames: null, critique: null,
      });
      if (render.stage === "infra") {
        // The studio's eyes are down and renderShader already waited them
        // out. Burning more drafts would end in a blind decline — park the
        // piece instead; the curator can send it back when the renderer is up.
        emitStudio("piece.parked", id, { log: (render.log || "").slice(0, 500) });
        await q.setStatus(id, "error");
        parked = true;
        break;
      }
      emitStudio("piece.render_failed", id, { iteration: idxBase + iter, log: (render.log || "").slice(0, 1500) });
      continue; // try a fresh iteration if budget remains
    }

    emitStudio("iteration.rendered", id, { iteration: idxBase + iter, frames: render.frames, glsl: draft.glsl });

    // 3 — The Critic looks
    setPhase("critique");
    const verdict = await critic({
      brief,
      frames: render.frames,
      artisanNotes: draft.notes,
      curatorNote,
    });
    critiqueHistory.push(verdict);
    await q.insertIteration(id, idxBase + iter, {
      glsl: draft.glsl, artisanNotes: draft.notes, compileOk: true,
      compileLog: null, frames: render.frames, critique: verdict,
    });
    await persist();
    emitStudio("critic.verdict", id, { iteration: idxBase + iter, verdict });

    if (verdict.verdict === "approve") {
      approvedGlsl = draft.glsl;
      hungCritique = verdict;
      break;
    }
    attempts.push({ critique: verdict, glsl: draft.glsl, idx: idxBase + iter });
  }

  // Out of revision rounds without an outright approval: the studio hangs
  // its strongest draft of this run if it clears the floor. Revisions can
  // drift from the brief, so the last draft is not always the best one.
  if (!approvedGlsl && !parked) {
    const ours = attempts.filter((a) => a.idx !== undefined);
    if (ours.length > 0) {
      const best = bestAttempt(ours);
      const overall = best.critique.scores.overall;
      emitStudio("studio.best_of", id, { iteration: best.idx, overall, floor: config.admitFloor, hung: overall >= config.admitFloor });
      if (overall >= config.admitFloor) {
        approvedGlsl = best.glsl;
        hungCritique = best.critique;
      }
    }
  }

  // 4 — Finalize or decline, and file the ledger
  if (approvedGlsl) {
    setPhase("finalizing");
    const existingTitles = (await q.recentApprovedSummaries(20).catch(() => [])).map((w) => w.title);
    const { title, statement } = await finalize({ brief, glsl: approvedGlsl, critiqueHistory, hungCritique, existingTitles });
    await q.approvePiece(id, approvedGlsl, title, statement, iterationsUsed);
    emitStudio("piece.approved", id, { title, statement, iterations: iterationsUsed });
    void ensurePoster(id, approvedGlsl).catch((err) => console.warn(`[posters] piece ${id}: ${String(err)}`));
  } else if (!parked) {
    await q.declinePiece(id, iterationsUsed);
    emitStudio("piece.declined", id, { iterations: iterationsUsed });
  }
  await q.clearCuratorNote(id).catch(() => {});
  const ledger = await persist();
  emitStudio("studio.ledger", id, { cost_usd: ledger.cost_usd, output_tokens: ledger.output_tokens, calls: ledger.calls });
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
  state.paused = (await q.getSetting<boolean>("paused").catch(() => null)) ?? false;
  // Recover orphans: a restart mid-composition leaves pieces stuck in
  // 'composing' with no worker. Re-queue them so the loop picks them up
  // fresh. (Single-worker studio, so anything 'composing' at boot is dead.)
  try {
    const requeued = await q.requeueOrphans();
    if (requeued > 0) {
      emitStudio("studio.recovered", null, { count: requeued });
    }
  } catch { /* non-fatal */ }
  if (!hasKey()) {
    emitStudio("studio.no_key", null, {
      message: "No ANTHROPIC_API_KEY configured — the ensemble is asleep. Gallery serves existing pieces only.",
    });
  }
  for (;;) {
    try {
      if (!hasKey()) { await sleep(30_000); continue; }
      if (state.billingHoldUntil) {
        if (Date.now() < state.billingHoldUntil) { await sleep(30_000); continue; }
        state.billingHoldUntil = null; // the rest is over — try again
      }
      // The curator's pause and the daily spend cap both hold new work; a
      // piece already in progress always finishes first.
      if (state.paused) { await sleep(10_000); continue; }
      if (config.dailySpendCap > 0) {
        const spent = (await q.spend24h()).cost_usd;
        if (spent >= config.dailySpendCap) {
          if (!state.spendHold) {
            state.spendHold = true;
            emitStudio("studio.spend_cap", null, { spent, cap: config.dailySpendCap });
          }
          await sleep(60_000);
          continue;
        }
        if (state.spendHold) {
          state.spendHold = false;
          emitStudio("studio.spend_resumed", null, { spent, cap: config.dailySpendCap });
        }
      }
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
      if (isBillingError(err)) {
        // Out of credits: rest instead of erroring. A commission — or any
        // piece that already earned a brief or drafts — returns to the queue
        // and survives the outage; a self-directed stub that never got a
        // brief is simply withdrawn, so no slot is burned and the studio
        // retries on the billing clock, not the 8-hour cadence.
        state.billingHoldUntil = Date.now() + BILLING_RETRY_MIN * 60_000;
        const retryAt = new Date(state.billingHoldUntil).toISOString();
        emitStudio("studio.billing", null, {
          message: `The studio's API account is out of credits. The ensemble rests and will try again in ${BILLING_RETRY_MIN} minutes.`,
          retryAt,
        });
        if (state.currentPieceId) {
          const id = state.currentPieceId;
          const requeued = await q.requeueForBilling(id).catch(() => false);
          if (!requeued) await q.deleteEmptyStub(id).catch(() => {});
        }
      } else {
        emitStudio("studio.error", state.currentPieceId, { message: msg.slice(0, 500) });
        if (state.currentPieceId) {
          await q.setStatus(state.currentPieceId, "error").catch(() => {});
        }
        await sleep(20_000); // back off (rate limits, transient API errors)
      }
    } finally {
      state.currentPieceId = null;
      // The idle-poll `continue` routes through here too — only announce
      // idle on a real transition, not 6×/minute forever.
      if (state.phase !== "idle") setPhase("idle", null);
    }
    await sleep(5_000);
  }
}
