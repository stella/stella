import { defineConfig } from "@playwright/test";

import marketingConfig from "@stll/playwright-tools/app-marketing-config";

export default defineConfig(marketingConfig, {
  testDir: "./marketing",
  retries: 0,
});
