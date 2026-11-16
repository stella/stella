import { expect, type Locator, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/control-states.fixture.html";

// Wider than `sm`, so the phone floor heights stay out of the measurements.
test.use({
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: true,
  deviceScaleFactor: 1,
});

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

test("caption triggers keep their visible metrics and keyboard focus", async ({
  page,
}) => {
  expect(
    await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
  ).toBe(true);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const trigger = page.getByRole("button", { name: "Matter", exact: true });
    const reference = page.getByTestId("caption-reference");
    const metrics = async (locator: Locator) =>
      locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          width: box.width,
          height: box.height,
          fontSize: style.fontSize,
          padding: style.padding,
          radius: style.borderRadius,
        };
      });
    expect(await metrics(trigger)).toEqual(await metrics(reference));
    const touchTarget = await trigger.evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return { width: style.minWidth, height: style.minHeight };
    });
    expect(touchTarget).toEqual({ width: "44px", height: "44px" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Choose matter" }),
    ).toBeVisible();
    await expect(trigger).toHaveClass(/outline-solid/u);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    const status = page.getByRole("button", { name: "Status", exact: true });
    await status.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText("Current sources", { exact: true }),
    ).toBeVisible();
    await expect(status).toHaveClass(/outline-solid/u);
    await expect(
      page.getByRole("button", { name: "Coverage details", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(status).toBeFocused();
    const rtlTrigger = page.getByTestId("rtl-caption");
    const rtlReference = page.getByTestId("rtl-caption-reference");
    expect((await rtlTrigger.boundingBox())?.width).toBeCloseTo(
      (await rtlReference.boundingBox())?.width ?? 0,
      1,
    );
    expect((await rtlTrigger.boundingBox())?.width).toBeLessThanOrEqual(220);
  }
});

test("inspector actions retain the fixed row and native disabled behavior", async ({
  page,
}) => {
  const action = page.getByRole("button", {
    name: "Duplicate matter",
    exact: true,
  });
  const original = page.getByRole("button", {
    name: "Original inspector action",
    exact: true,
  });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await height(original)).toBe(width < 640 ? 48 : 32);
    expect(await height(action)).toBe(48);
  }
  await expect(
    page.getByRole("button", { name: "Duplicate content", exact: true }),
  ).toBeDisabled();
});
