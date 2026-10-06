import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/src/components/fixtures/split-button.fixture.html";
const primaryName = "Create document";
const menuName = "More document actions";

test.use({
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

const openFixture = async (page: Page, query = "") => {
  await page.goto(`${fixturePath}${query}`);
  await expect(page.getByRole("button", { name: primaryName })).toBeVisible();
};

test("tabs to each action separately in document order", async ({ page }) => {
  await openFixture(page);
  await page.getByRole("button", { name: "Before", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: primaryName })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: menuName })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "After", exact: true }),
  ).toBeFocused();
});

for (const key of ["ArrowDown", "Enter", "Space"] as const) {
  test(`opens the menu with ${key} on the chevron`, async ({ page }) => {
    await openFixture(page);
    const trigger = page.getByRole("button", { name: menuName });
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.focus();
    await page.keyboard.press(key);
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("menuitem", { name: "Create from template" }),
    ).toBeFocused();
    await expect(page.getByLabel("Primary actions")).toHaveAttribute(
      "data-count",
      "0",
    );
    await expect(page.getByLabel("Menu state")).toHaveText("open");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
}

test("primary activation only runs the primary action", async ({ page }) => {
  await openFixture(page);
  const primary = page.getByRole("button", { name: primaryName });
  await primary.click();
  await primary.press("Enter");
  await primary.press("Space");
  await expect(page.getByLabel("Primary actions")).toHaveAttribute(
    "data-count",
    "3",
  );
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(page.getByLabel("Menu state")).toHaveText("closed");
  await expect(page.getByLabel("Menu actions")).toHaveAttribute(
    "data-count",
    "0",
  );
  await page.getByRole("button", { name: menuName }).click();
  await page.getByRole("menuitem", { name: "Create from template" }).click();
  await expect(page.getByLabel("Menu actions")).toHaveAttribute(
    "data-count",
    "1",
  );
  await expect(page.getByLabel("Primary actions")).toHaveAttribute(
    "data-count",
    "3",
  );
});

test("disabled primary leaves the menu available", async ({ page }) => {
  await openFixture(page, "?disabled=primary");
  const primary = page.getByRole("button", { name: primaryName });
  await expect(primary).toBeDisabled();
  await primary.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(page.getByLabel("Primary actions")).toHaveAttribute(
    "data-count",
    "0",
  );
  const trigger = page.getByRole("button", { name: menuName });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Create from template" }).click();
  await expect(page.getByLabel("Menu actions")).toHaveAttribute(
    "data-count",
    "1",
  );
  await expect(page.getByLabel("Primary actions")).toHaveAttribute(
    "data-count",
    "0",
  );
});

test("disabled menu leaves the primary action available", async ({ page }) => {
  await openFixture(page, "?disabled=menu");
  await expect(page.getByRole("button", { name: menuName })).toBeDisabled();
  const primary = page.getByRole("button", { name: primaryName });
  await expect(primary).toBeEnabled();
  await primary.click();
  await expect(page.getByLabel("Primary actions")).toHaveAttribute(
    "data-count",
    "1",
  );
  await expect(page.getByRole("menu")).toBeHidden();
});

for (const surface of ["menu", "popover"] as const) {
  test(`preserves descriptions on both ${surface} actions`, async ({
    page,
  }) => {
    await openFixture(page, `?surface=${surface}`);
    await expect(
      page.getByRole("button", { name: primaryName }),
    ).toHaveAccessibleDescription("Creates a blank document");
    await expect(
      page.getByRole("button", { name: menuName }),
    ).toHaveAccessibleDescription("Additional document actions");
  });
}

for (const key of ["Enter", "Space"] as const) {
  test(`opens a form popover with ${key} and keeps native keyboard navigation`, async ({
    page,
  }) => {
    await openFixture(page, "?surface=popover");
    const trigger = page.getByRole("button", { name: menuName });
    await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.focus();
    await page.keyboard.press(key);
    const dialog = page.getByRole("dialog", { name: "Document question" });
    await expect(dialog).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(
      dialog.getByRole("button", { name: "Use a preset" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    const question = dialog.getByRole("textbox", { name: "Question" });
    await expect(question).toBeFocused();
    await question.fill("Explain this document");
    await page.keyboard.press("Tab");
    const submit = dialog.getByRole("button", { name: "Submit question" });
    await expect(submit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Menu actions")).toHaveAttribute(
      "data-count",
      "1",
    );
    await expect(page.getByLabel("Primary actions")).toHaveAttribute(
      "data-count",
      "0",
    );
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(question).toBeFocused();
    await expect(question).toHaveValue("Explain this document");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByLabel("Menu state")).toHaveText("closed");
  });
}

for (const size of ["sm", "md"] as const) {
  for (const dir of ["ltr", "rtl"] as const) {
    test(`keeps both ${size} actions joined in ${dir}`, async ({ page }) => {
      await openFixture(page, `?size=${size}&dir=${dir}`);
      const primary = page.getByRole("button", { name: primaryName });
      const trigger = page.getByRole("button", { name: menuName });
      const primaryBox = await primary.boundingBox();
      const triggerBox = await trigger.boundingBox();
      if (!primaryBox || !triggerBox) {
        throw new Error("Split button actions must have visible bounds");
      }
      expect(primaryBox.y).toBe(triggerBox.y);
      expect(primaryBox.height).toBe(triggerBox.height);
      const gap =
        dir === "rtl"
          ? primaryBox.x - triggerBox.x - triggerBox.width
          : triggerBox.x - primaryBox.x - primaryBox.width;
      expect(Math.abs(gap)).toBeLessThanOrEqual(1);
      await trigger.click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(page.getByLabel("Primary actions")).toHaveAttribute(
        "data-count",
        "0",
      );
    });
  }
}
