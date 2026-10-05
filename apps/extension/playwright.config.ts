import { defineConfig } from "@playwright/test";

export default defineConfig({
  fullyParallel: false,
  retries: 0,
  reporter: process.env["CI"]
    ? [
        ["line"],
        [
          "json",
          {
            outputFile:
              process.env["PLAYWRIGHT_JSON_OUTPUT_FILE"] ??
              ".cache/playwright-timings.json",
          },
        ],
      ]
    : [["line"]],
  testDir: "./e2e",
  timeout: 90_000,
  use: {
    trace: "retain-on-failure",
  },
  workers: 1,
});
