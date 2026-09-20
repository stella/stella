const DEFAULT_API_URL = "http://localhost:3001";
const DEFAULT_WEB_URL = "http://localhost:3000";

export const WORKSPACE_REPLAY_ENV = {
  apiUrl: process.env["E2E_API_URL"] ?? DEFAULT_API_URL,
  apiUrlOverride: process.env["E2E_API_URL"],
  commit: process.env["GITHUB_SHA"] ?? "unknown",
  isCi: process.env["CI"] !== undefined,
  outputDir: process.env["E2E_OUTPUT_DIR"],
  replayPath: process.env["E2E_SOAK_REPLAY"],
  seed: process.env["E2E_SOAK_SEED"],
  steps: process.env["E2E_SOAK_STEPS"],
  webUrl: process.env["E2E_WEB_URL"] ?? DEFAULT_WEB_URL,
  webUrlOverride: process.env["E2E_WEB_URL"],
} as const;
