import { defineConfig } from "@playwright/test";

const PORT = 4177;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  reporter: process.env["CI"]
    ? [
        ["dot"],
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
  testDir: "./tests/browser",
  testMatch: "**/*.playwright.spec.ts",
  fullyParallel: true,
  // Every test runs in its own browser context with the native bridge mocked
  // inside the page, and the Vite server only serves modules, so tests share
  // no state. In CI the suite has the runner to itself and two workers fit its
  // cores beside the server; locally one worker leaves room for other work.
  workers: process.env["CI"] ? 2 : 1,
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
