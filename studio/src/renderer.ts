import { config } from "./config.js";

export interface RenderResult {
  ok: boolean;
  frames?: string[];   // data-URI images
  stage?: string;      // compile | link | runtime | context | infra
  log?: string;
}

// Gitops redeploys rebuild the renderer for ~10 minutes (Chromium apt layer),
// during which the studio would otherwise burn a fresh draft per failed call
// and the Critic would decline a piece it never saw. Infra failures therefore
// wait for the renderer's /healthz and retry the SAME shader; only an answer
// from a live renderer (compile/runtime verdicts included) is reported upward.

const RENDER_ATTEMPTS = 3;
const HEALTH_WAIT_MS = 12 * 60_000;
const HEALTH_POLL_MS = 15_000;

async function rendererHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${config.rendererUrl}/healthz`, { signal: AbortSignal.timeout(3_000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitForRenderer(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await rendererHealthy()) return true;
    console.log("[studio] renderer unreachable — waiting for it to come back…");
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

export async function renderShader(glsl: string): Promise<RenderResult> {
  for (let attempt = 1; attempt <= RENDER_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${config.rendererUrl}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({
          glsl,
          width: config.frame.width,
          height: config.frame.height,
          times: config.frame.times,
        }),
      });
      if (res.ok) return (await res.json()) as RenderResult;
      if (res.status < 500) return { ok: false, stage: "runtime", log: `renderer HTTP ${res.status}` };
      // 5xx: the renderer is up but unwell — treat like an outage and retry.
    } catch {
      // unreachable / timed out — fall through to the health wait
    }
    if (attempt < RENDER_ATTEMPTS) await waitForRenderer(HEALTH_WAIT_MS);
  }
  return { ok: false, stage: "infra", log: "renderer unreachable after retries — draft preserved, not the shader's fault" };
}
