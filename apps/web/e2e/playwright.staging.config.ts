import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// Post-deploy verification against a live deployed environment
// (deploy-staging.yml `verify-staging`). Unlike playwright.config.ts
// this suite has no local stack: it authenticates via the
// secret-guarded /smoke/session endpoint in global-setup and runs a
// minimal click-through that a broken deploy cannot pass.

const STAGING_WEB_URL =
  process.env["E2E_WEB_URL"] ?? "https://staging.stll.app";

// Optional edge access header, sent on every request the smoke makes when
// the deployed environment's edge expects one. Absent env keeps this a
// no-op, so the suite runs unchanged against environments without it.
const EDGE_HEADER_NAME = process.env["E2E_EDGE_HEADER_NAME"] ?? "";
const EDGE_HEADER_VALUE = process.env["E2E_EDGE_HEADER_VALUE"] ?? "";

export const EDGE_HEADERS: Record<string, string> =
  EDGE_HEADER_NAME && EDGE_HEADER_VALUE
    ? { [EDGE_HEADER_NAME]: EDGE_HEADER_VALUE }
    : {};

export const STAGING_STORAGE_STATE = path.resolve(
  import.meta.dirname,
  "../../../.playwright/staging-storage-state.json",
);

export default defineConfig({
  testDir: "./staging",
  globalSetup: "./staging/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["github"], ["list"], ["html", { open: "never" }]],
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: STAGING_WEB_URL,
    extraHTTPHeaders: EDGE_HEADERS,
    storageState: STAGING_STORAGE_STATE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
