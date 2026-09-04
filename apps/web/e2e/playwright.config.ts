import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { resolveE2eExecutionProfile } from "./execution-profile";

// Mirrors apps/api/scripts/seed-test-user.ts:349 — repo-root .playwright/
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");

const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const IS_CI = process.env["CI"] !== undefined;
const executionProfile = resolveE2eExecutionProfile(
  process.env["E2E_EXECUTION_PROFILE"],
);

export default defineConfig({
  testDir: "./specs",
  globalTeardown: "./global-teardown.ts",
  // Network measurements use one fixture-owning group before mutation specs.
  // Broad production checks use two workers; local runs retain four workers.
  fullyParallel: true,
  workers: IS_CI ? executionProfile.workerCount : 4,
  // CI failures are almost always real (server logs, traces tell the story).
  // Retries hide flakes; fix them in code instead.
  retries: 0,
  reporter: IS_CI
    ? [
        ["blob", { outputDir: "test-results/blob-report" }],
        ["github"],
        ["list"],
      ]
    : [["list"], ["html", { open: "never" }]],
  // Cold Vite + folio editor compile on a fresh CI runner can use 25-30s
  // before the first locator runs, leaving no headroom for in-spec
  // toBeVisible waits and killing tests that would otherwise pass.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: WEB_BASE_URL,
    storageState: STORAGE_STATE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: "chromium",
      testIgnore: /heap-growth-canary\.spec\.ts$/u,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Isolated so --js-flags=--expose-gc (needed for window.gc() inside
      // heap-growth-canary.spec.ts) never touches V8's GC behavior for any
      // other spec. Keep this project's testMatch and the "chromium"
      // project's testIgnore above in sync so the spec runs exactly once.
      name: "heap-growth-canary",
      testMatch: /heap-growth-canary\.spec\.ts$/u,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--js-flags=--expose-gc"] },
      },
    },
  ],

  // We do NOT start the dev server from Playwright. Spinning up dev inside
  // Playwright fights the docker stack (Postgres/RustFS/Valkey/Gotenberg) and
  // hides "is dev broken" vs. "is the test broken". CI starts the stack via
  // explicit steps; locally, run `bun run dev` first.
  metadata: {
    apiBaseURL: API_BASE_URL,
  },
});
