import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { resolveE2eExecutionProfile } from "./execution-profile";

// Mirrors apps/api/scripts/seed-test-user.ts:349 — repo-root .playwright/
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");

const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const IS_CI = process.env["CI"] !== undefined;
const E2E_OUTPUT_DIR = process.env["E2E_OUTPUT_DIR"] ?? "test-results";
const E2E_BLOB_OUTPUT_DIR = path.join(E2E_OUTPUT_DIR, "blob-report");
const executionProfile = resolveE2eExecutionProfile(
  process.env["E2E_EXECUTION_PROFILE"],
);

const ROUTE_SMOKE_SPEC = /route-smoke\.spec\.ts$/u;
const HEAP_GROWTH_CANARY_SPEC = /heap-growth-canary\.spec\.ts$/u;

export default defineConfig({
  testDir: "./specs",
  globalTeardown: "./global-teardown.ts",
  outputDir: E2E_OUTPUT_DIR,
  // The production CI profile keeps the general suite parallel. Route smoke
  // runs in a separate invocation so its fixture setup cannot overlap with
  // workspace-mutating tests on the same stack.
  fullyParallel: true,
  workers: IS_CI ? executionProfile.workerCount : 4,
  // CI failures are almost always real (server logs, traces tell the story).
  // Retries hide flakes; fix them in code instead.
  retries: 0,
  reporter: IS_CI
    ? [["blob", { outputDir: E2E_BLOB_OUTPUT_DIR }], ["github"], ["list"]]
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
      testIgnore: [ROUTE_SMOKE_SPEC, HEAP_GROWTH_CANARY_SPEC],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Isolated so --js-flags=--expose-gc (needed for window.gc() inside
      // heap-growth-canary.spec.ts) never touches V8's GC behavior for any
      // other spec. Its file is also ignored by chromium above so it runs
      // exactly once.
      name: "heap-growth-canary",
      testMatch: HEAP_GROWTH_CANARY_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--js-flags=--expose-gc"] },
      },
    },
    {
      // Route fixtures are shared by serial groups. A dedicated project keeps
      // the route invocation single-worker while the CI workflow runs it only
      // after the general suite has finished.
      name: "route-smoke",
      testMatch: ROUTE_SMOKE_SPEC,
      workers: 1,
      use: { ...devices["Desktop Chrome"] },
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
