import { defineConfig } from "@playwright/test";

import marketingConfig from "@stll/playwright-tools/landing-marketing-config";

export default defineConfig(marketingConfig, {
  testDir: ".",
  retries: 0,
});
