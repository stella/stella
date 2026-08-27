import { expect, test } from "@playwright/test";

const THEME_STORAGE_KEY = "stella-ui-theme";
const CONTROL_SIZES_SECTION = "control-sizes";

test.beforeEach(async ({ page }, testInfo) => {
  const { colorScheme } = testInfo.project.use;
  if (colorScheme !== "dark" && colorScheme !== "light") {
    throw new Error(
      `UI playground project must declare a light or dark color scheme, received ${String(colorScheme)}`,
    );
  }

  await page.addInitScript(
    ([storageKey, storedTheme]) => {
      localStorage.setItem(storageKey, storedTheme);
    },
    [THEME_STORAGE_KEY, colorScheme] as const,
  );
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
