import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { readJourneyEdgeHeaders, readJourneyWebUrl } from "./journeys/env";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

export const JOURNEY_SEEDED_STORAGE_STATE = path.resolve(
  REPO_ROOT,
  ".playwright/storage-state.json",
);

export const JOURNEY_STORAGE_STATE = path.resolve(
  REPO_ROOT,
  ".playwright/journeys-storage-state.json",
);

export const JOURNEY_TAG = {
  deployed: "@deployed",
  localStack: "@local-stack",
} as const;

export default defineConfig({
  testDir: "./journeys",
  globalSetup: "./journeys/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["github"], ["list"], ["html", { open: "never" }]],
  timeout: 180_000,
  expect: { timeout: 30_000 },

  use: {
    baseURL: readJourneyWebUrl(),
    extraHTTPHeaders: readJourneyEdgeHeaders(),
    storageState: JOURNEY_STORAGE_STATE,
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },

  projects: [
    {
      name: "deployed",
      grep: new RegExp(JOURNEY_TAG.deployed, "u"),
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "local-stack",
      grep: new RegExp(JOURNEY_TAG.localStack, "u"),
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
