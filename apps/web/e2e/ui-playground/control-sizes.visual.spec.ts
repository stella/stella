import { expect, test } from "@playwright/test";

import { setPresentationPrefs } from "../helpers/presentation-prefs";

const CONTROL_SIZES_SECTION = "control-sizes";

test.beforeEach(async ({ page, baseURL }, testInfo) => {
  const { colorScheme } = testInfo.project.use;
  if (colorScheme !== "dark" && colorScheme !== "light") {
    throw new Error(
      `UI playground project must declare a light or dark color scheme, received ${String(colorScheme)}`,
    );
  }

  if (baseURL === undefined) {
    throw new Error("UI playground requires a base URL");
  }
  await setPresentationPrefs({
    context: page.context(),
    url: baseURL,
    patch: { theme: colorScheme },
  });
  await page.goto("/dev?visual=control-sizes", {
    waitUntil: "domcontentloaded",
  });
});

test("keeps the shared control-size matrix stable", async ({ page }) => {
  const section = page.locator(
    `[data-playground-section="${CONTROL_SIZES_SECTION}"]`,
  );

  await expect(section).toBeVisible();
  await page.evaluate(async () => await document.fonts.ready);
  await expect(section).toHaveScreenshot("control-sizes.png", {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.005,
    scale: "css",
  });
});
