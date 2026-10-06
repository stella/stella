import { defineConfig, devices } from "@playwright/test";

const IS_CI = process.env["CI"] !== undefined;
const E2E_OUTPUT_DIR = process.env["E2E_OUTPUT_DIR"] ?? "test-results";

// Browser checks for API-owned browser code (the visual sandbox runtime).
// They need a running API (E2E_API_URL) but no web app.
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: E2E_OUTPUT_DIR,
  fullyParallel: true,
  retries: 0,
  reporter: IS_CI
    ? [
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
    : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
