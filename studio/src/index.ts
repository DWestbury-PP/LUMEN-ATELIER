import { config, hasKey } from "./config.js";
import { ensureSchema, waitForDb } from "./db.js";
import { seedIfEmpty } from "./seeds.js";
import { buildServer } from "./server.js";
import { studioLoop } from "./loop.js";

async function main() {
  console.log("[studio] waiting for database…");
  await waitForDb();
  await ensureSchema();

  const seeded = await seedIfEmpty();
  if (seeded) console.log("[studio] gallery seeded with calibration pieces");

  const app = buildServer();
  app.listen(config.port, () => {
    console.log(`[studio] api listening on :${config.port}`);
    console.log(`[studio] ensemble: muse=${config.models.muse} artisan=${config.models.artisan} critic=${config.models.critic}`);
    console.log(hasKey()
      ? "[studio] ANTHROPIC_API_KEY present — the ensemble is awake"
      : "[studio] no ANTHROPIC_API_KEY — gallery-only mode (the ensemble sleeps)");
  });

  studioLoop().catch((err) => {
    console.error("[studio] loop crashed:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error("[studio] fatal:", err);
  process.exit(1);
});
