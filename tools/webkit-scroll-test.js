// WebKit scroll test for the Lumen Atelier gallery.
// Emulates an iPad Pro viewport in Playwright's WebKit (the engine under
// every iPad/iPhone browser), walks the gallery top to bottom and back,
// screenshots along the way, and probes painter state from inside the page.
// It found two real bugs on day one: OffscreenCanvas-without-WebGL leaving
// the wall black, and context-eviction storms convicting innocent shaders.
//
// Run (from repo root, no host installs — screenshots land in ./wkout):
//   mkdir -p wkout && docker run --rm \
//     -v "$PWD/tools/webkit-scroll-test.js":/work/test.js \
//     -v "$PWD/wkout":/out -w /work --ipc=host \
//     mcr.microsoft.com/playwright:v1.50.0-noble \
//     bash -c "npm i --loglevel=error playwright@1.50.0 >/dev/null 2>&1 && node test.js"
//
// Caveat: this WebKit renders on a SOFTWARE GPU (llvmpipe) — API behavior
// is faithful, performance is far below any real device. Expect the
// governor to engage and some honest 'heavy' verdicts that hardware passes.
const { webkit, devices } = require("playwright");

const URL = "https://lumen-atelier.up.railway.app/";
const OUT = "/out";

const probe = () => {
  const canvases = [...document.querySelectorAll(".glwrap canvas")];
  const readPx = (c) => {
    try {
      const k = document.createElement("canvas");
      k.width = 32; k.height = 18;
      const g = k.getContext("2d");
      g.drawImage(c, 0, 0, 32, 18);
      const d = g.getImageData(0, 0, 32, 18).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
      return s;
    } catch (e) { return "readfail:" + e.message; }
  };
  const inView = canvases.filter((c) => {
    const r = c.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.width > 0;
  });
  return {
    offscreen: typeof OffscreenCanvas !== "undefined",
    offscreenGl2: (() => { try { return !!new OffscreenCanvas(4, 4).getContext("webgl2"); } catch { return false; } })(),
    canvasGl2: (() => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; } })(),
    inViewSizes: inView.map((c) => c.width + "x" + c.height),
    bitmaprenderer: !!document.createElement("canvas").getContext("bitmaprenderer"),
    parallelCompile: (() => {
      try {
        const gl = new OffscreenCanvas(4, 4).getContext("webgl2");
        return gl ? !!gl.getExtension("KHR_parallel_shader_compile") : null;
      } catch { return null; }
    })(),
    tiles: canvases.length,
    inView: inView.length,
    inViewPainted: inView.map(readPx),
    overlays: {
      error: document.querySelectorAll(".gl-error").length,
      heavy: document.querySelectorAll(".gl-heavy").length,
    },
  };
};

(async () => {
  const ipad = devices["iPad Pro 11"];
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ ...ipad });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log("[console]", m.type(), m.text().slice(0, 300));
  });

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  console.log("[caps+top]", JSON.stringify(await page.evaluate(probe)));
  await page.screenshot({ path: `${OUT}/00-top.png` });

  // Scroll to the bottom in steps, screenshotting along the way.
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await page.evaluate(() => window.scrollBy({ top: document.documentElement.clientHeight * 1.4, behavior: "instant" }));
    await page.waitForTimeout(1800);
    if (i === 3 || i === 6 || i === steps) {
      console.log(`[step${i}]`, JSON.stringify(await page.evaluate(probe)));
      await page.screenshot({ path: `${OUT}/${String(i).padStart(2, "0")}-down.png` });
    }
  }
  // Back to the top: frozen frames should be there instantly, then resume.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(2500);
  console.log("[returned-top]", JSON.stringify(await page.evaluate(probe)));
  await page.screenshot({ path: `${OUT}/99-return-top.png` });

  await browser.close();
  console.log("done");
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
