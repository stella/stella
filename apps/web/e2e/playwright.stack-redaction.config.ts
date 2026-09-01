import { defineConfig, devices } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:4176";
const IS_CI = process.env["CI"] !== undefined;

export default defineConfig({
  testDir: "./stack-redaction",
  testMatch: "stack-redaction.spec.ts",
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: IS_CI ? [["github"], ["list"]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "firefox-stack-redaction",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit-stack-redaction",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: "bun --bun vite --config stack-redaction/vite.config.ts",
    url: BASE_URL,
    reuseExistingServer: !IS_CI,
    timeout: 30_000,
  },
});
