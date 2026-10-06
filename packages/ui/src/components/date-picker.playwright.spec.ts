import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/src/components/fixtures/date-picker.fixture.html";

const openFixture = async (page: Page) => {
  await page.goto(fixturePath);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["datePickerReady"] ?? "",
        ),
    )
    .toBe("true");
};

const dayCellSize = async (page: Page, triggerId: string) => {
  await page.locator(`#${triggerId}`).click();
  const day = page.locator(
    '[data-slot="date-picker-popup"] [data-date="2026-03-05"]',
  );
  await expect(day).toBeVisible();
  const box = await day.boundingBox();
  await page.keyboard.press("Escape");
  await expect(day).toBeHidden();
  return box;
};

test("names the popup and its navigation with the host's labels", async ({
  page,
}) => {
  await openFixture(page);
  await page.locator("#localized").click();

  const dialog = page.getByRole("dialog", { name: "Výběr data" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Předchozí měsíc" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Další měsíc" }),
  ).toBeVisible();
  // `hideClear` keeps a set value without a way to empty it.
  await expect(
    dialog.getByRole("button", { name: "Vymazat datum" }),
  ).toHaveCount(0);

  const heading = dialog.locator('[data-slot="date-picker-heading"]');
  await heading.click();
  await expect(dialog.getByRole("button", { name: "Další rok" })).toBeVisible();

  await expect(heading).toHaveText("2026");
  await heading.click();
  await expect(
    dialog.getByRole("button", { name: "Předchozí desetiletí" }),
  ).toBeVisible();
});

test("date-time mode keeps the time when the day changes", async ({ page }) => {
  await openFixture(page);
  const value = page.getByRole("status", { name: "Date-time value" });
  await page.locator("#date-time").click();

  const popup = page.locator('[data-slot="date-picker-popup"]');
  await popup.locator('[data-date="2026-03-10"]').click();
  await expect(value).toHaveText("2026-03-10T09:15");

  const time = popup.getByRole("group", { name: "Start time" });
  await time.getByRole("combobox", { name: "Hour" }).click();
  await page.getByRole("option", { name: /^2\sPM$/u }).click();
  await expect(value).toHaveText("2026-03-10T14:15");

  await time.getByRole("combobox", { name: "Minute" }).click();
  await page.getByRole("option", { name: "30", exact: true }).click();
  await expect(value).toHaveText("2026-03-10T14:30");
  // Choosing from the nested selects leaves the picker open.
  await expect(popup).toBeVisible();
  await expect(page.locator("#date-time")).toContainText("2:30");
});

test.describe("on a coarse pointer", () => {
  test("touch-size day cells reach 44px; compact cells stay dense", async ({
    page,
  }) => {
    await openFixture(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);

    const touch = await dayCellSize(page, "touch");
    const compact = await dayCellSize(page, "compact");

    expect(touch?.width).toBeGreaterThanOrEqual(44);
    expect(touch?.height).toBeGreaterThanOrEqual(44);
    expect(compact?.width).toBe(32);
  });
});

test.describe("on a fine pointer", () => {
  test.use({ hasTouch: false, isMobile: false });

  test("touch-size day cells keep the compact metric", async ({ page }) => {
    await openFixture(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: fine)").matches),
    ).toBe(true);

    const touch = await dayCellSize(page, "touch");

    expect(touch?.width).toBe(32);
  });
});

test("date triggers and their labels keep their geometry when opened", async ({
  page,
}) => {
  await openFixture(page);
  for (const triggerId of ["localized", "field", "empty-field"]) {
    const trigger = page.locator(`#${triggerId}`);
    const label = page.locator(`#${triggerId}-label`);
    const triggerBox = await trigger.boundingBox();
    const labelBox = (await label.count()) ? await label.boundingBox() : null;
    await trigger.hover();
    expect(await trigger.boundingBox()).toEqual(triggerBox);
    await trigger.focus();
    expect(await trigger.boundingBox()).toEqual(triggerBox);
    await trigger.click();
    await expect(page.locator('[data-slot="date-picker-popup"]')).toBeVisible();
    expect(await trigger.boundingBox()).toEqual(triggerBox);
    if (labelBox) {
      expect(await label.boundingBox()).toEqual(labelBox);
    }
    const focusDay =
      triggerId === "empty-field"
        ? page.locator('[data-slot="date-picker-popup"] [aria-current="date"]')
        : page.locator(
            '[data-slot="date-picker-popup"] [data-date="2026-03-05"]',
          );
    await expect(focusDay).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="date-picker-popup"]')).toBeHidden();
    expect(await trigger.boundingBox()).toEqual(triggerBox);
  }
});
