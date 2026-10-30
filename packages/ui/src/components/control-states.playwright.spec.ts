import { expect, type Locator, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/control-states.fixture.html";

// Wider than `sm`, so the phone floor heights stay out of the measurements.
test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.goto(fixturePath);
  await expect(
    page.getByRole("button", { name: "Selected card" }),
  ).toBeVisible();
});

const outlineWidth = async (locator: Locator) =>
  await locator.evaluate((element) => getComputedStyle(element).outlineWidth);

const height = async (locator: Locator) =>
  await locator.evaluate((element) => element.getBoundingClientRect().height);

test("a selected plain target is drawn apart from an unselected one", async ({
  page,
}) => {
  const unselected = page.getByRole("button", { name: "Unselected card" });
  const selected = page.getByRole("button", { name: "Selected card" });

  expect(await outlineWidth(unselected)).toBe("0px");
  expect(await outlineWidth(selected)).toBe("2px");
});

test("a fixed textarea is as tall as its rows, and only a growing one has a floor", async ({
  page,
}) => {
  const growing = page.getByRole("textbox", { name: "Growing note" });
  const oneRow = page.getByRole("textbox", { name: "One fixed row" });
  const twoRows = page.getByRole("textbox", { name: "Two fixed rows" });

  const growingHeight = await height(growing);
  const oneRowHeight = await height(oneRow);
  const twoRowHeight = await height(twoRows);

  expect(twoRowHeight).toBeGreaterThan(oneRowHeight);
  expect(oneRowHeight).toBeLessThan(growingHeight);
});
