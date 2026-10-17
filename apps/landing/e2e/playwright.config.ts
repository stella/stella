import { defineConfig } from "@playwright/test";
import path from "node:path";

import marketingBaseConfig from "@stll/playwright-tools/marketing-config";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

export default defineConfig(marketingBaseConfig, {
  testDir: ".",
  testMatch: /landing-.*\.spec\.ts$/u,
  outputDir: path.join(REPO_ROOT, "apps/landing/test-results"),
  projects: [
    {
      name: "landing",
      use: {
        baseURL: process.env["E2E_LANDING_URL"] ?? "http://localhost:4321",
      },
    },
  ],
});
