type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// A numeric setting from the environment. Tolerates trailing text such as an
// inline "# comment" (docker --env-file keeps those), and falls back to the
// default rather than NaN: a NaN round count or spend cap fails silently.
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = parseFloat(raw);
  if (Number.isFinite(n)) return n;
  console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a number; using ${fallback}`);
  return fallback;
}

export const config = {
  port: num("PORT", 8181),
  databaseUrl: process.env.DATABASE_URL || "postgres://lumen:lumen@localhost:5432/lumen",
  rendererUrl: process.env.RENDERER_URL || "http://localhost:8282",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  models: {
    // Sonnet 5.5 conceives, Opus 5.5 paints and judges. Opus 5.5 is cheaper
    // per token than Opus 5 and reads images markedly better — the Critic's
    // eye is the studio's quality ceiling.
    muse: process.env.MUSE_MODEL || "claude-sonnet-5-5",
    artisan: process.env.ARTISAN_MODEL || "claude-opus-5-5",
    critic: process.env.CRITIC_MODEL || "claude-opus-5-5",
  },
  // Thinking depth for the Artisan. "medium" is deliberate: drafts are cheap
  // in this studio (the Critic catches problems), deliberation is not.
  artisanEffort: (process.env.ARTISAN_EFFORT || "medium") as Effort,
  // The Critic is the gate, so it judges at "high" — set explicitly, because
  // Opus 5.5 defaults to "medium".
  criticEffort: (process.env.CRITIC_EFFORT || "high") as Effort,
  autoCreate: (process.env.AUTO_CREATE || "true").toLowerCase() === "true",
  autoCreateIntervalMin: num("AUTO_CREATE_INTERVAL_MIN", 120),
  maxIterations: Math.max(1, Math.floor(num("MAX_ITERATIONS", 4))),
  // When the revision rounds run out without an outright approval, the
  // strongest draft hangs if the Critic scored it at least this (overall).
  admitFloor: num("ADMIT_FLOOR", 6.5),
  // No new piece starts while the last 24 hours' spend is at or above this
  // (USD). 0 turns the cap off.
  dailySpendCap: num("DAILY_SPEND_CAP", 5),
  // Minutes the studio rests after the API account runs out of credits.
  billingRetryMin: num("BILLING_RETRY_MIN", 30),
  // Frames the Critic sees, and their timestamps (seconds into the piece).
  frame: { width: 512, height: 288, times: [0.8, 3.5, 8.2, 15.0] },

  // ── Auth & deployment ──
  // Google OAuth client ID for Sign in with Google (frontend + token audience).
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  // HMAC secret for session cookies. Required in production.
  sessionSecret: process.env.SESSION_SECRET || "",
  // Emails that are automatically granted the admin role on sign-in.
  adminEmails: (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  // If set, the studio serves the built gallery from this directory
  // (single-container deployments, e.g. Railway).
  staticDir: process.env.STATIC_DIR || "",
  // Secure cookies (set to "true" behind HTTPS).
  secureCookies: (process.env.SECURE_COOKIES || "false").toLowerCase() === "true",
};

export const hasKey = () => Boolean(config.anthropicApiKey);
