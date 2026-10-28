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
  testDir: "./ui-playground",
  // `*.visual.spec.ts` compares screenshots; `*.geometry.spec.ts` compares
  // measured boxes, which a screenshot cannot assert on and a unit test cannot
  // reach. Runtime specs exercise browser-only modules through this same Vite
  // server and its production package conditions.
  testMatch: "**/*.@(visual|geometry|runtime).spec.ts",
  // Every test loads its own page and shares nothing with the others, so they
  // spread across workers. One page load on the dev server costs about 6 s,
  // which made the single-worker run about 10 min long.
  fullyParallel: true,
  workers: 4,
  retries: 0,
  // A clean Linux checkout compiles the shared app shell and focused route on
  // the first visit; the parallel first visits wait on that one compile.
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
