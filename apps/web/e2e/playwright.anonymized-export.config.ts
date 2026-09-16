import { defineConfig, devices } from "@playwright/test";

const BASE_URL = "http://127.0.0.1:4177";
const IS_CI = process.env["CI"] !== undefined;

export default defineConfig({
  testDir: "./anonymized-export",
  testMatch: "anonymized-export.spec.ts",
  workers: 1,
  retries: 0,
  reporter: IS_CI ? [["github"], ["list"]] : [["list"]],
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-anonymized-export",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun --bun vite --config anonymized-export/vite.config.ts",
    url: BASE_URL,
    reuseExistingServer: !IS_CI,
    timeout: 30_000,
  },
});
