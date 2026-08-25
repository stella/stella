import { defineConfig } from "@playwright/test";

export default defineConfig({
  fullyParallel: false,
  reporter: "line",
  testDir: "./e2e",
  timeout: 90_000,
  use: {
    trace: "retain-on-failure",
  },
  workers: 1,
});
