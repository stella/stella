import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./src",
  testMatch: "**/*.playwright.spec.ts",
  fullyParallel: true,
  // One worker, like every other Playwright profile in the repo: the drag and
  // keyboard interactions here are timing-bound, and in CI this suite shares
  // the runner with other packages' tests, so parallel browser contexts
  // starve each other into spurious failures.
  workers: 1,
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
