import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

const fixturePath = "/src/components/fixtures/list-items.fixture.html";

test.beforeEach(async ({ page }) => {
  await page.goto(fixturePath);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["listItemsReady"] ?? "",
        ),
    )
    .toBe("true");
});

const expectClippedInside = async (popup: Locator, option: Locator) => {
  await expect(popup).toBeVisible();
  await expect(option).toBeVisible();
  const popupBox = await popup.boundingBox();
  const optionBox = await option.boundingBox();
  if (!popupBox || !optionBox) {
    throw new Error("popup or option has no box");
  }
  // The option, and the text inside it, stay within the popup's edges.
  expect(optionBox.x + optionBox.width).toBeLessThanOrEqual(
    popupBox.x + popupBox.width + 1,
  );
  const text = option.locator("span.truncate");
  const textBox = await text.boundingBox();
  if (!textBox) {
    throw new Error("truncating span has no box");
  }
  expect(textBox.x + textBox.width).toBeLessThanOrEqual(
    popupBox.x + popupBox.width + 1,
  );
  // Clipping engaged instead of the track growing to fit the text.
  const overflow = await text.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
};

test("a combobox option clips a label wider than its popup", async ({
  page,
}) => {
  await page.getByRole("combobox", { name: "Order" }).click();
  await expectClippedInside(
    page.locator('[data-slot="combobox-popup"]'),
    page.getByRole("option", { name: /Very long option label/u }),
  );
});

test("a select option clips a label wider than its popup", async ({ page }) => {
  await page.getByRole("combobox", { name: "Category" }).click();
  await expectClippedInside(
    page.locator('[data-slot="select-popup"]'),
    page.getByRole("option", { name: /Very long option label/u }),
  );
});
