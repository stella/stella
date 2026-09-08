import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.playwright.spec.ts",
  fullyParallel: true,
  workers: 1,
  retries: 0,
  use: {
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    baseURL: "http://127.0.0.1:4177",
    viewport: { height: 326, width: 1100 },
  },
  webServer: {
    command: "vite --host 127.0.0.1 --port 4177",
    port: 4177,
  },
});
