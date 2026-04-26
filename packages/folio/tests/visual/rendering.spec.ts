/**
 * Visual regression tests for DOCX rendering.
 *
 * Drop .docx files into tests/visual/fixtures/ and they'll be
 * automatically tested. Each fixture renders in the playground,
 * and every page is screenshotted and compared against baselines.
 *
 * Usage:
 *   bunx playwright test --project=chromium           # run tests
 *   bunx playwright test --update-snapshots           # approve current renders as baseline
 *   bunx playwright show-report                       # view diff report
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
const __dirname = import.meta.dirname;
const FIXTURES_DIR = path.join(__dirname, "fixtures");

// Auto-discover all .docx files in the fixtures directory
const fixtures = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".docx"))
  .sort();

for (const fixture of fixtures) {
  test.describe(fixture, () => {
    test(`renders correctly`, async ({ page }) => {
      // Load the fixture via query param
      await page.goto(`/?file=${encodeURIComponent(fixture)}`);

      // Wait for the editor to finish rendering
      // The editor sets data-testid="docx-editor" on the root element
      await page.waitForSelector('[data-testid="docx-editor"]', {
        timeout: 10_000,
      });

      // Wait for layout to complete — the paged editor adds page elements
      // Give it a moment for fonts + layout + paint
      await page.waitForTimeout(1000);

      // Hide the toolbar and status bar for cleaner screenshots
      // (we're testing document rendering, not UI chrome)
      await page.evaluate(() => {
        // Hide toolbar
        const toolbar = document.querySelector('[role="toolbar"]');
        if (toolbar instanceof HTMLElement) {
          toolbar.style.display = "none";
        }
        // Hide any status/control bars outside the editor
        const controls = document.querySelectorAll(
          '[data-testid="playground-controls"]',
        );
        for (const el of controls) {
          if (el instanceof HTMLElement) {
            el.style.display = "none";
          }
        }
      });

      // Screenshot the entire editor area
      const editor = page.locator('[data-testid="docx-editor"]');
      await expect(editor).toHaveScreenshot(`${fixture}.png`, {
        fullPage: false,
      });
    });
  });
}

// Fail-safe: ensure we have at least one fixture
test("fixtures directory is not empty", () => {
  expect(fixtures.length).toBeGreaterThan(0);
});
