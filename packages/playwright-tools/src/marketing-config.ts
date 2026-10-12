import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

import { playwrightEnv } from "./env";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

type MarketingConfigOptions = {
  testDir: string;
  project: "app" | "landing";
};

export const marketingConfig = ({ testDir, project }: MarketingConfigOptions) =>
  defineConfig({
    reporter: playwrightEnv.ci
      ? [
          ["dot"],
          [
            "json",
            {
              outputFile:
                playwrightEnv.jsonOutputFile ??
                ".cache/playwright-timings.json",
            },
          ],
        ]
      : [["list"]],
    testDir,
    outputDir: path.join(
      REPO_ROOT,
      "apps",
      project === "landing" ? "landing" : "web",
      "test-results",
    ),
    fullyParallel: false,
    workers: 1,
    retries: 0,
    // One test walks every capture in both themes (20 shots), each first visit
    // paying a cold route compile; a full pass on the CI runner takes ~4 min.
    timeout: 600_000,
    expect: { timeout: 15_000 },
    snapshotPathTemplate: path.join(
      REPO_ROOT,
      "apps/landing/public/media/products/{arg}{ext}",
    ),
    use: {
      ...devices["Desktop Chrome"],
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      locale: "en-GB",
      trace: "retain-on-failure",
      // The dev server compiles route chunks on demand, and a module the entry
      // is still waiting on holds DOMContentLoaded open. The test runner puts
      // no timeout on navigation by default, so a wedged compile would burn the
      // whole test budget before failing; this bounds the navigation while
      // leaving room for the one-time compile. Matches COLD_COMPILE_TIMEOUT in
      // the app specs.
      navigationTimeout: 60_000,
    },
    projects: [
      ...(project === "app"
        ? [
            {
              name: "app",
              testIgnore: /landing-.*\.spec\.ts$/u,
              use: {
                baseURL: playwrightEnv.webUrl ?? "http://localhost:3000",
                storageState: path.join(
                  REPO_ROOT,
                  ".playwright/storage-state.json",
                ),
              },
            },
          ]
        : [
            {
              name: "landing",
              testMatch: /landing-.*\.spec\.ts$/u,
              use: {
                baseURL: playwrightEnv.landingUrl ?? "http://localhost:4321",
              },
            },
          ]),
    ],
  });
