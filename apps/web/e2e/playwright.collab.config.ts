import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config";

export default defineConfig(baseConfig, {
  fullyParallel: false,
  testDir: "./collab",
  timeout: 180_000,
  workers: 1,
});
