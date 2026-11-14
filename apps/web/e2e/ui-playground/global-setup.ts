import { chromium } from "@playwright/test";

import {
  UI_PLAYGROUND_WARM_URL,
  UI_PLAYGROUND_WARM_VISUAL,
} from "../playwright.ui-playground.config";

/**
 * The web server's readiness probe only fetches the page's HTML. The browser
 * modules behind it (the app shell, the route tree, the dev route) are
 * compiled on the first browser visit, which on a clean CI runner takes about
 * two minutes. Rendering one playground fixture here pays for that compile
 * once, before any test starts, so the first tests of a run measure their
 * fixture instead of racing the cold compile against their own deadlines.
 */
const COLD_COMPILE_BUDGET_MS = 300_000;

const globalSetup = async (): Promise<void> => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(UI_PLAYGROUND_WARM_URL, { waitUntil: "domcontentloaded" });
    await page
      .locator(`[data-playground-section="${UI_PLAYGROUND_WARM_VISUAL}"]`)
      .waitFor({ state: "visible", timeout: COLD_COMPILE_BUDGET_MS });
  } finally {
    await browser.close();
  }
};

export default globalSetup;
