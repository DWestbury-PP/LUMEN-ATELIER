export const config = {
  port: Number(process.env.PORT || 8181),
  databaseUrl: process.env.DATABASE_URL || "postgres://lumen:lumen@localhost:5432/lumen",
  rendererUrl: process.env.RENDERER_URL || "http://localhost:8282",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  models: {
    muse: process.env.MUSE_MODEL || "claude-haiku-4-5",
    artisan: process.env.ARTISAN_MODEL || "claude-sonnet-5",
    critic: process.env.CRITIC_MODEL || "claude-opus-4-8",
  },
  // Thinking depth for the Artisan. "medium" is deliberate: drafts are cheap
  // in this studio (the Critic catches problems), deliberation is not.
  artisanEffort: (process.env.ARTISAN_EFFORT || "medium") as "low" | "medium" | "high",
  autoCreate: (process.env.AUTO_CREATE || "true").toLowerCase() === "true",
  autoCreateIntervalMin: Number(process.env.AUTO_CREATE_INTERVAL_MIN || 120),
  maxIterations: Math.max(1, Number(process.env.MAX_ITERATIONS || 4)),
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
