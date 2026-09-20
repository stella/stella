import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { WORKSPACE_REPLAY_ENV } from "./soak/env";

// Mirrors apps/api/scripts/seed-test-user.ts:349 — repo-root .playwright/.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");

const DEFAULT_OUTPUT_DIR = "test-results/workspace-soak";
const REPLAY_OUTPUT_DIR = "test-results/workspace-soak-replay";
const replayPath = WORKSPACE_REPLAY_ENV.replayPath;
const replayUsesDefaultOutput =
  replayPath !== undefined &&
  path
    .resolve(replayPath)
    .startsWith(
      `${path.resolve(import.meta.dirname, DEFAULT_OUTPUT_DIR)}${path.sep}`,
    );
const OUTPUT_DIR =
  WORKSPACE_REPLAY_ENV.outputDir ??
  (replayUsesDefaultOutput ? REPLAY_OUTPUT_DIR : DEFAULT_OUTPUT_DIR);

export default defineConfig({
  testDir: "./soak",
  testMatch: "**/*.playwright.spec.ts",
  globalTeardown: "./global-teardown.ts",
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: WORKSPACE_REPLAY_ENV.isCi,
  reporter: WORKSPACE_REPLAY_ENV.isCi
    ? [
        ["blob", { outputDir: path.join(OUTPUT_DIR, "blob-report") }],
        ["github"],
        ["list"],
      ]
    : [["list"], ["html", { open: "never" }]],
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: WORKSPACE_REPLAY_ENV.webUrl,
    storageState: STORAGE_STATE,
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  metadata: {
    apiBaseURL: WORKSPACE_REPLAY_ENV.apiUrl,
  },
});
