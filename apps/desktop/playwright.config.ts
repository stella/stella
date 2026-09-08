import { defineConfig, devices } from "@playwright/test";

const PORT = 4177;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.playwright.spec.ts",
  fullyParallel: true,
  workers: 1,
  retries: 0,
  use: {
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    baseURL: BASE_URL,
    viewport: { height: 326, width: 1100 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `vite --host 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
  },
});
