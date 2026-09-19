import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// Mirrors apps/api/scripts/seed-test-user.ts:349 — repo-root .playwright/.
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");

const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const IS_CI = process.env["CI"] !== undefined;
const DEFAULT_OUTPUT_DIR = "test-results/workspace-soak";
const REPLAY_OUTPUT_DIR = "test-results/workspace-soak-replay";
const replayPath = process.env["E2E_SOAK_REPLAY"];
const replayUsesDefaultOutput =
  replayPath !== undefined &&
  path
    .resolve(replayPath)
    .startsWith(
      `${path.resolve(import.meta.dirname, DEFAULT_OUTPUT_DIR)}${path.sep}`,
    );
const OUTPUT_DIR =
  process.env["E2E_OUTPUT_DIR"] ??
  (replayUsesDefaultOutput ? REPLAY_OUTPUT_DIR : DEFAULT_OUTPUT_DIR);

export default defineConfig({
  testDir: "./soak",
  testMatch: "**/*.playwright.spec.ts",
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
      ]
    : [["list"], ["html", { open: "never" }]],
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: WEB_BASE_URL,
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
    apiBaseURL: API_BASE_URL,
  },
});
