import { defineConfig } from "@playwright/test";
import path from "node:path";

import { playwrightEnv } from "./env";
import marketingConfig, { MARKETING_REPO_ROOT } from "./marketing-config";

export default defineConfig(marketingConfig, {
  retries: 0,
  outputDir: path.join(MARKETING_REPO_ROOT, "apps/web/test-results"),
  projects: [
    {
      name: "app",
      testIgnore: /landing-.*\.spec\.ts$/u,
      use: {
        baseURL: playwrightEnv.webUrl ?? "http://localhost:3000",
        storageState: path.join(
          MARKETING_REPO_ROOT,
          ".playwright/storage-state.json",
        ),
      },
    },
  ],
});
