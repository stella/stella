import { defineConfig, devices } from "@playwright/test";

// Fixture host only: no web server, account or storage state is required.
export default defineConfig({
  testDir: "./specs",
  testMatch: "mcp-*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
