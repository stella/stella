import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

export default defineConfig({
  testDir: "./marketing",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  snapshotPathTemplate: path.join(
    REPO_ROOT,
    "apps/landing/public/media/products/{arg}{ext}",
  ),
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env["E2E_WEB_URL"] ?? "http://localhost:3000",
    storageState: path.join(REPO_ROOT, ".playwright/storage-state.json"),
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-GB",
    trace: "retain-on-failure",
  },
});
