import { defineConfig } from "@playwright/test";
import path from "node:path";

import { playwrightEnv } from "./env";
import marketingConfig, { MARKETING_REPO_ROOT } from "./marketing-config";

export default defineConfig(marketingConfig, {
  retries: 0,
  outputDir: path.join(MARKETING_REPO_ROOT, "apps/landing/test-results"),
  projects: [
    {
      name: "landing",
      testMatch: /landing-.*\.spec\.ts$/u,
      use: {
        baseURL: playwrightEnv.landingUrl ?? "http://localhost:4321",
      },
    },
  ],
});
