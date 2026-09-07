import { expect, type Page } from "@playwright/test";

const INTERACTION_TIMEOUT_MS = 1000;
const HYDRATION_TIMEOUT_MS = 30_000;

/** Opens the global-search date picker despite a public route's hydration remount. */
export const openGlobalSearchDatePicker = async (page: Page) => {
  const searchButton = page
    .locator('[data-slot="sidebar"]')
    .getByRole("button", { name: /search|hledat/iu });
  const customRangeButton = page.getByRole("button", {
    name: /custom range|vlastní rozsah/iu,
  });
  const datePickerTrigger = page
    .getByRole("button", { name: /select date|vybrat datum/iu })
    .first();
  const dayGrid = page.locator('[role="gridcell"]').first();

  // Public routes expose SSR controls before React has attached handlers. The
  // browser-context remount can also close a dialog opened during hydration,
  // so retry the whole interaction instead of only the final popover click.
  await expect(async () => {
    if (await dayGrid.isVisible()) {
      return;
    }
    if (await datePickerTrigger.isVisible()) {
      if ((await datePickerTrigger.getAttribute("aria-expanded")) !== "true") {
        await datePickerTrigger.click({ timeout: INTERACTION_TIMEOUT_MS });
      }
    } else if (await customRangeButton.isVisible()) {
      await customRangeButton.click({ timeout: INTERACTION_TIMEOUT_MS });
    } else {
      await searchButton.click({ timeout: INTERACTION_TIMEOUT_MS });
    }
    await expect(dayGrid).toBeVisible({ timeout: INTERACTION_TIMEOUT_MS });
  }).toPass({ timeout: HYDRATION_TIMEOUT_MS });
};
