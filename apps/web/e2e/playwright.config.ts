import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

// Mirrors apps/api/scripts/seed-test-user.ts:349 — repo-root .playwright/
const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const STORAGE_STATE = resolve(REPO_ROOT, ".playwright/storage-state.json");

const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";
const API_BASE_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";
const IS_CI = process.env["CI"] !== undefined;

export default defineConfig({
  testDir: "./specs",
  // Each spec creates and tears down its own workspace, so parallelism
  // is safe. Capped at 4 locally to keep Postgres/MinIO contention
  // modest; serial in CI because two specs cold-compiling heavy route
  // chunks (folio, chat) on a 2-core runner starve each other past
  // their expect timeouts.
  fullyParallel: true,
  workers: IS_CI ? 1 : 4,
  // CI failures are almost always real (server logs, traces tell the story).
  // Retries hide flakes; fix them in code instead.
  retries: 0,
  reporter: IS_CI
    ? [["github"], ["html", { open: "never" }], ["list"]]
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
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  // We do NOT start the dev server from Playwright. Spinning up dev inside
  // Playwright fights the docker stack (Postgres/MinIO/Valkey/Gotenberg) and
  // hides "is dev broken" vs. "is the test broken". CI starts the stack via
  // explicit steps; locally, run `bun run dev` first.
  metadata: {
    apiBaseURL: API_BASE_URL,
  },
});
