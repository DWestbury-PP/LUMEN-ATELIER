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
  autoCreate: (process.env.AUTO_CREATE || "true").toLowerCase() === "true",
  autoCreateIntervalMin: Number(process.env.AUTO_CREATE_INTERVAL_MIN || 45),
  maxIterations: Math.max(1, Number(process.env.MAX_ITERATIONS || 4)),
  // Frames the Critic sees, and their timestamps (seconds into the piece).
  frame: { width: 512, height: 288, times: [0.8, 3.5, 8.2, 15.0] },
};

export const hasKey = () => Boolean(config.anthropicApiKey);
