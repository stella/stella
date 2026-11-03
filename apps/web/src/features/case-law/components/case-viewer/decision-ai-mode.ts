// Dependency-free so browser specs can name the mode without importing the
// workspace's component graph.
/**
 * Whether a decision reader offers AI to an account or gates it. The reader's
 * root carries it as `data-ai-mode`.
 */
export const DECISION_AI_MODE = {
  enabled: "enabled",
  gated: "gated",
} as const;
