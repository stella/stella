import { defineConfig } from "@playwright/test";

const PORT = 4177;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.playwright.spec.ts",
  fullyParallel: true,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env["CI"]),
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: {
    baseURL: BASE_URL,
    viewport: { height: 326, width: 1100 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    serviceWorkers: "block",
  },
  webServer: {
    command: `vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
  },
});
