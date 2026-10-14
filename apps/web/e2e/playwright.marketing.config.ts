import { defineConfig } from "@playwright/test";
import path from "node:path";

import marketingBaseConfig from "@stll/playwright-tools/marketing-config";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

export default defineConfig(marketingBaseConfig, {
  testDir: "./marketing",
  testIgnore: /landing-.*\.spec\.ts$/u,
  outputDir: path.join(REPO_ROOT, "apps/web/test-results"),
  projects: [
    {
      name: "app",
      use: {
        baseURL: process.env["E2E_WEB_URL"] ?? "http://localhost:3000",
        storageState: path.join(REPO_ROOT, ".playwright/storage-state.json"),
      },
    },
  ],
});
