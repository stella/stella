import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src/kanban",
  testMatch: "**/*.playwright.spec.ts",
  fullyParallel: true,
  retries: 0,
  use: {
    ...devices["iPhone 13"],
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4174",
  },
  webServer: {
    command: "vite --host 127.0.0.1 --port 4174",
    port: 4174,
    reuseExistingServer: !process.env["CI"],
  },
});
