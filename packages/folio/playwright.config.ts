import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  timeout: 30_000,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01, // 1% pixel tolerance (sub-pixel font rounding)
      threshold: 0.2, // per-pixel color sensitivity
      animations: "disabled",
    },
  },
  use: {
    baseURL: "http://localhost:4200",
    browserName: "chromium",
    viewport: { width: 1280, height: 900 },
    // Consistent rendering across machines
    deviceScaleFactor: 2,
    colorScheme: "light",
  },
  // Start playground dev server automatically
  webServer: {
    command: "bun --filter @stella/playground dev",
    url: "http://localhost:4200",
    reuseExistingServer: true,
    cwd: "../..",
  },
});
