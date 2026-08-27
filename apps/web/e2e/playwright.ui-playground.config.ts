import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const UI_PLAYGROUND_BASE_URL = "http://127.0.0.1:4175";
const IS_CI = process.env["CI"] !== undefined;

const sharedUse = {
  ...devices["Desktop Chrome"],
  baseURL: UI_PLAYGROUND_BASE_URL,
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  serviceWorkers: "block",
  viewport: { width: 1440, height: 900 },
} as const;

export default defineConfig({
  testDir: "./ui-playground",
  testMatch: "**/*.visual.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A clean Linux checkout compiles the shared app shell and focused route on
  // the first visit; later theme projects reuse that graph and finish quickly.
  timeout: 180_000,
  expect: { timeout: 120_000 },
  snapshotPathTemplate: path.join(
    REPO_ROOT,
    "apps/web/e2e/ui-playground/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}",
  ),
  projects: [
    {
      name: "light-ltr",
      use: { ...sharedUse, colorScheme: "light", locale: "en-GB" },
    },
    {
      name: "dark-ltr",
      use: { ...sharedUse, colorScheme: "dark", locale: "en-GB" },
    },
    {
      name: "light-rtl",
      use: { ...sharedUse, colorScheme: "light", locale: "ar" },
    },
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run dev -- --host 127.0.0.1 --port 4175",
    url: `${UI_PLAYGROUND_BASE_URL}/dev?visual=control-sizes`,
    reuseExistingServer: !IS_CI,
    timeout: 120_000,
  },
});
