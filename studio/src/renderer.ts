import { config } from "./config.js";

export interface RenderResult {
  ok: boolean;
  frames?: string[];   // data-URI PNGs
  stage?: string;      // compile | link | runtime | context
  log?: string;
}

export async function renderShader(glsl: string): Promise<RenderResult> {
  const res = await fetch(`${config.rendererUrl}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      glsl,
      width: config.frame.width,
      height: config.frame.height,
      times: config.frame.times,
    }),
  });
  if (!res.ok) return { ok: false, stage: "runtime", log: `renderer HTTP ${res.status}` };
  return (await res.json()) as RenderResult;
}
