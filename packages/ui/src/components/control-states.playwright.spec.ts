import { expect, type Locator, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/control-states.fixture.html";

// Wider than `sm`, so the phone floor heights stay out of the measurements.
test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.goto(fixturePath);
  await expect(
    page.getByRole("button", { name: "Selected card", exact: true }),
  ).toBeVisible();
});

// An outline is drawn by its style: with `outline-style: none` the browser
// still reports a width, so the style is what tells drawn from not drawn.
const outline = async (locator: Locator) =>
  await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });

const height = async (locator: Locator) =>
  await locator.evaluate((element) => element.getBoundingClientRect().height);

test("a selected plain target is drawn apart from an unselected one", async ({
  page,
}) => {
  const unselected = page.getByRole("button", {
    name: "Unselected card",
    exact: true,
  });
  const selected = page.getByRole("button", {
    name: "Selected card",
    exact: true,
  });

  expect((await outline(unselected)).style).toBe("none");
  expect(await outline(selected)).toEqual({ style: "solid", width: "2px" });
});

test("a fixed textarea is as tall as its rows, and only a growing one has a floor", async ({
  page,
}) => {
  const growing = page.getByRole("textbox", {
    name: "Growing note",
    exact: true,
  });
  const oneRow = page.getByRole("textbox", {
    name: "One fixed row",
    exact: true,
  });
  const twoRows = page.getByRole("textbox", {
    name: "Two fixed rows",
    exact: true,
  });

  const growingHeight = await height(growing);
  const oneRowHeight = await height(oneRow);
  const twoRowHeight = await height(twoRows);

  expect(twoRowHeight).toBeGreaterThan(oneRowHeight);
  expect(oneRowHeight).toBeLessThan(growingHeight);
});
