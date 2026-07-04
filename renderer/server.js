// Lumen Atelier — renderer service
//
// Compiles a GLSL ES 3.00 fragment shader inside headless Chromium
// (SwiftShader software WebGL2 — no GPU required) and captures PNG frames
// at fixed timestamps. This is how the Critic "sees" the Artisan's work.
//
// POST /render { glsl, width?, height?, times? }
//   -> { ok: true,  frames: ["data:image/png;base64,...", ...] }
//   -> { ok: false, stage: "compile"|"link"|"runtime", log: "..." }

import http from "node:http";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.PORT || 8282);
const CHROMIUM = process.env.CHROMIUM_PATH || "/usr/bin/chromium";
const DEFAULT_TIMES = [0.8, 3.5, 8.2, 15.0];
const MAX_DIM = 1024;
const RENDER_TIMEOUT_MS = 45_000;

const PAGE_HTML = `<!doctype html><html><body><script>
window.renderShader = function (glsl, width, height, times) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl2", {
    preserveDrawingBuffer: true,
    antialias: false,
    powerPreference: "low-power",
  });
  if (!gl) return { ok: false, stage: "context", log: "WebGL2 context unavailable" };

  const VS = "#version 300 es\\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || "unknown compile error";
      gl.deleteShader(sh);
      return { error: log };
    }
    return { shader: sh };
  }

  const vs = compile(gl.VERTEX_SHADER, VS);
  if (vs.error) return { ok: false, stage: "compile", log: "vertex: " + vs.error };
  const fs = compile(gl.FRAGMENT_SHADER, glsl);
  if (fs.error) return { ok: false, stage: "compile", log: fs.error };

  const prog = gl.createProgram();
  gl.attachShader(prog, vs.shader);
  gl.attachShader(prog, fs.shader);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    return { ok: false, stage: "link", log: gl.getProgramInfoLog(prog) || "link failed" };
  }

  gl.useProgram(prog);
  const uRes = gl.getUniformLocation(prog, "iResolution");
  const uTime = gl.getUniformLocation(prog, "iTime");
  gl.viewport(0, 0, width, height);

  const frames = [];
  try {
    for (const t of times) {
      if (uRes) gl.uniform2f(uRes, width, height);
      if (uTime) gl.uniform1f(uTime, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      frames.push(canvas.toDataURL("image/png"));
    }
  } catch (e) {
    return { ok: false, stage: "runtime", log: String(e) };
  } finally {
    gl.deleteProgram(prog);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);
    const ext = gl.getExtension("WEBGL_lose_context");
    if (ext) ext.loseContext();
  }
  return { ok: true, frames };
};
</script></body></html>`;

let browser = null;
let page = null;
let queue = Promise.resolve(); // serialize renders — one page, one context at a time

async function ensurePage() {
  if (page && !page.isClosed()) return page;
  if (browser) {
    try { await browser.close(); } catch {}
  }
  browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--disable-background-timer-throttling",
    ],
  });
  page = await browser.newPage();
  await page.setContent(PAGE_HTML, { waitUntil: "domcontentloaded" });
  return page;
}

async function render(glsl, width, height, times) {
  const p = await ensurePage();
  return p.evaluate(
    (g, w, h, t) => window.renderShader(g, w, h, t),
    glsl, width, height, times
  );
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(data);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    return json(res, 200, { ok: true });
  }
  if (req.method !== "POST" || req.url !== "/render") {
    return json(res, 404, { ok: false, log: "not found" });
  }

  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return json(res, 400, { ok: false, log: "bad json" }); }
    const glsl = String(parsed.glsl || "");
    if (!glsl.trim()) return json(res, 400, { ok: false, log: "missing glsl" });
    const width = Math.min(Math.max(Number(parsed.width) || 512, 64), MAX_DIM);
    const height = Math.min(Math.max(Number(parsed.height) || 288, 64), MAX_DIM);
    const times = Array.isArray(parsed.times) && parsed.times.length
      ? parsed.times.slice(0, 8).map(Number)
      : DEFAULT_TIMES;

    queue = queue.then(async () => {
      try {
        const result = await Promise.race([
          render(glsl, width, height, times),
          new Promise((_, rej) => setTimeout(() => rej(new Error("render timeout")), RENDER_TIMEOUT_MS)),
        ]);
        json(res, 200, result);
      } catch (err) {
        // A hung/crashed page poisons the browser; recycle it.
        try { if (browser) await browser.close(); } catch {}
        browser = null; page = null;
        json(res, 200, { ok: false, stage: "runtime", log: String(err.message || err) });
      }
    });
  });
});

server.listen(PORT, () => console.log(`[renderer] listening on :${PORT} (chromium: ${CHROMIUM})`));

process.on("SIGTERM", async () => {
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});
