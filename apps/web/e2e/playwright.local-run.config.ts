import { defineConfig } from "@playwright/test";
import path from "node:path";

import { devices } from "@stll/playwright-tools/devices";

// Chats that run on the member's computer, against the stand-in computer:
// `bun run agent:up -- --local-runner` starts it locally, and CI starts it
// with `packages/scripts/src/e2e-local-runner.ts`. There is one computer and the tests
// take it offline and relink it, so they run one at a time.

// Mirrors apps/api/scripts/seed-test-user.ts: repo-root .playwright/.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");

const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const IS_CI = process.env["CI"] !== undefined;
const OUTPUT_DIR = "test-results/local-run";

export default defineConfig({
  testDir: "./local-run",
  testMatch: "**/*.spec.ts",
  globalTeardown: "./global-teardown.ts",
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: IS_CI,
  reporter: IS_CI
    ? [
        ["blob", { outputDir: path.join(OUTPUT_DIR, "blob-report") }],
        ["github"],
        ["list"],
        [
          "json",
          {
            outputFile:
              process.env["PLAYWRIGHT_JSON_OUTPUT_FILE"] ??
              ".cache/playwright-timings.json",
          },
        ],
      ]
    : [["list"], ["html", { open: "never" }]],
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: WEB_BASE_URL,
    storageState: STORAGE_STATE,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  projects: [{ name: "local-run", use: { ...devices["Desktop Chrome"] } }],

  metadata: { apiBaseURL: API_BASE_URL },
});
