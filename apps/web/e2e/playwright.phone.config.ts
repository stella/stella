import { defineConfig, devices } from "@playwright/test";

import baseConfig from "./playwright.config";

// The route walk on the narrowest iPhone on a current iOS, in WebKit like
// Safari: a page that fits 375px fits every newer, wider iPhone. CI runs it in
// the route-smoke job, on the same stack, after the network baseline.
export default defineConfig(baseConfig, {
  testDir: "./phone",
  workers: 1,
  projects: [
    {
      name: "phone-layout",
      use: { ...devices["iPhone SE (3rd gen)"] },
    },
  ],
});
