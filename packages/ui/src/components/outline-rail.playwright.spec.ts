import { expect, test, type Locator, type Page } from "@playwright/test";

import { OUTLINE_CONTROL_MIN_SIZE } from "./outline-rail";

const fixturePath = "/src/components/fixtures/outline-rail.fixture.html";
const VIEWPORT = { width: 390, height: 800 };

test.use({
  viewport: VIEWPORT,
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

const openFixture = async (
  page: Page,
  presentation: "panel" | "rail" | "popover",
) => {
  await page.goto(`${fixturePath}?presentation=${presentation}`, {
    waitUntil: "domcontentloaded",
  });
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["outlineRailReady"] ?? "",
        ),
    )
    .toBe("true");
};

const readBox = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error("Expected the visible fixture element to have a box");
  }
  return box;
};

const readPublishedInset = async (page: Page) =>
  page
    .getByLabel("Document outline host")
    .evaluate((element) =>
      Number.parseFloat(
        element.parentElement?.style.getPropertyValue(
          "--document-panel-bottom-inset",
        ) ?? "0",
      ),
    );

test("heading page numbers expose their meaning and a shared tooltip", async ({
  page,
}) => {
  await openFixture(page, "panel");
  const pageNumber = page
    .getByRole("button", { name: "Page 1", exact: true })
    .first();
  await expect(pageNumber).toHaveText("1");
  const pageNumberBox = await readBox(pageNumber);
  expect(pageNumberBox.width).toBeGreaterThanOrEqual(OUTLINE_CONTROL_MIN_SIZE);
  expect(pageNumberBox.height).toBeGreaterThanOrEqual(OUTLINE_CONTROL_MIN_SIZE);
  await pageNumber.hover();
  const tooltip = page.locator('[data-slot="tooltip-popup"]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText("Page 1");
  await page.mouse.move(0, 0);
  await pageNumber.focus();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText("Page 1");
});

test("panel tracks the published composer inset and keeps its last row reachable", async ({
  page,
}) => {
  await openFixture(page, "panel");

  const panel = page.getByRole("navigation", { name: "Document outline" });
  const header = page.getByTestId("outline-header");
  const viewport = panel.locator('[data-slot="scroll-area-viewport"]');
  const firstRow = panel.locator("li").first();
  const lastRow = panel.locator("li").last();
  const composer = page.getByTestId("composer");

  await expect(panel).toBeVisible();
  await expect
    .poll(async () => {
      const headerBox = await header.boundingBox();
      const rowBox = await firstRow.boundingBox();
      return headerBox && rowBox
        ? rowBox.y - (headerBox.y + headerBox.height)
        : -1;
    })
    .toBeGreaterThanOrEqual(0);

  const initialInset = await readPublishedInset(page);
  expect(initialInset).toBeGreaterThanOrEqual(80);
  const viewportBox = await readBox(viewport);
  const composerBox = await readBox(composer);
  expect(viewportBox.y + viewportBox.height).toBeLessThanOrEqual(composerBox.y);

  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(async () => {
      const rowBox = await lastRow.boundingBox();
      const composerBounds = await composer.boundingBox();
      return rowBox && composerBounds
        ? rowBox.y + rowBox.height <= composerBounds.y
        : false;
    })
    .toBe(true);

  await page.getByTestId("resize-composer").click();
  await expect
    .poll(async () => readPublishedInset(page))
    .toBeGreaterThan(initialInset);
  const resizedViewportBox = await readBox(viewport);
  const resizedComposerBox = await readBox(composer);
  expect(resizedViewportBox.y + resizedViewportBox.height).toBeLessThanOrEqual(
    resizedComposerBox.y,
  );
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(async () => {
      const rowBox = await lastRow.boundingBox();
      const composerBounds = await composer.boundingBox();
      return rowBox && composerBounds
        ? rowBox.y + rowBox.height <= composerBounds.y
        : false;
    })
    .toBe(true);

  const host = page.getByLabel("Document outline host");
  const hostBox = await readBox(host);
  const panelBox = await readBox(panel);
  expect(panelBox.x).toBeGreaterThanOrEqual(hostBox.x);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(
    hostBox.x + hostBox.width,
  );
});

test("removing the composer clears its published inset", async ({ page }) => {
  await openFixture(page, "panel");
  await expect.poll(async () => readPublishedInset(page)).toBeGreaterThan(0);

  await page.getByTestId("remove-composer").click();
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect
    .poll(async () =>
      page
        .getByLabel("Document outline host")
        .evaluate(
          (element) =>
            element.parentElement?.style.getPropertyValue(
              "--document-panel-bottom-inset",
            ) ?? "",
        ),
    )
    .toBe("");
});

test("narrow viewport keeps the native panel visible and within its host", async ({
  page,
}) => {
  await openFixture(page, "panel");
  const panel = page.getByRole("navigation", { name: "Document outline" });
  const host = page.getByLabel("Document outline host");

  await expect(panel).toBeVisible();
  const panelBox = await readBox(panel);
  const hostBox = await readBox(host);
  expect(panelBox.x).toBeGreaterThanOrEqual(hostBox.x);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(VIEWPORT.width);
});

test("rail fills the host below its host-owned toggle", async ({ page }) => {
  await openFixture(page, "rail");
  const toggle = page.getByTestId("host-toggle");
  const ticks = page.locator("[data-outline-ticks]");
  const toggleBox = await readBox(toggle);
  const ticksBox = await readBox(ticks);
  expect(ticksBox.y).toBeGreaterThanOrEqual(toggleBox.y + toggleBox.height);
});

for (const presentation of ["rail", "popover"] as const) {
  test(`${presentation} keeps its last tick above the composer as it grows`, async ({
    page,
  }) => {
    await openFixture(page, presentation);
    const track = page.locator("[data-outline-ticks]");
    const lastTick = track.locator("button").last();
    const composer = page.getByTestId("composer");
    await expect(lastTick).toBeVisible();
    const initialInset = await readPublishedInset(page);
    expect(initialInset).toBeGreaterThanOrEqual(80);
    await expect
      .poll(async () => {
        const tickBox = await readBox(lastTick);
        const composerBox = await readBox(composer);
        return tickBox.y + tickBox.height <= composerBox.y;
      })
      .toBe(true);

    await page.getByTestId("resize-composer").click();
    await expect
      .poll(async () => readPublishedInset(page))
      .toBeGreaterThan(initialInset);
    await expect
      .poll(async () => {
        const tickBox = await readBox(lastTick);
        const composerBox = await readBox(composer);
        return tickBox.y + tickBox.height <= composerBox.y;
      })
      .toBe(true);
  });
}

test("popover trigger has a usable target and does not cover any tick", async ({
  page,
}) => {
  await openFixture(page, "popover");
  const trigger = page.getByRole("button", { name: "Document outline" });
  const triggerBox = await readBox(trigger);
  expect(triggerBox.width).toBeGreaterThanOrEqual(OUTLINE_CONTROL_MIN_SIZE);
  expect(triggerBox.height).toBeGreaterThanOrEqual(OUTLINE_CONTROL_MIN_SIZE);

  const ticks = await page.locator("[data-outline-ticks] button").all();
  expect(ticks.length).toBeGreaterThan(0);
  for (const tick of ticks) {
    const tickBox = await readBox(tick);
    const overlaps =
      triggerBox.x < tickBox.x + tickBox.width &&
      triggerBox.x + triggerBox.width > tickBox.x &&
      triggerBox.y < tickBox.y + tickBox.height &&
      triggerBox.y + triggerBox.height > tickBox.y;
    expect(overlaps).toBe(false);
  }
});

test.describe("coarse-pointer controls", () => {
  test.use({ hasTouch: true });

  test("disclosure and tree controls keep 32px visuals with 44px touch targets", async ({
    page,
  }) => {
    await openFixture(page, "popover");
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const trigger = page.getByRole("button", {
      name: "Document outline",
      exact: true,
    });
    const triggerBox = await readBox(trigger);
    expect(triggerBox.width).toBe(OUTLINE_CONTROL_MIN_SIZE);
    expect(triggerBox.height).toBe(OUTLINE_CONTROL_MIN_SIZE);
    const assertTouchTarget = async (control: Locator) => {
      const target = await control.evaluate((element) => {
        const style = getComputedStyle(element, "::after");
        return {
          width: Number.parseFloat(style.width),
          height: Number.parseFloat(style.height),
        };
      });
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    };
    await assertTouchTarget(trigger);
    // Four pixels beyond the painted edge must still operate the disclosure.
    await page.mouse.click(
      triggerBox.x + triggerBox.width + 4,
      triggerBox.y + triggerBox.height / 2,
    );
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const collapse = page
      .getByRole("button", { name: "Collapse", exact: true })
      .first();
    await assertTouchTarget(collapse);
    await assertTouchTarget(
      page.getByRole("button", { name: "Page 1", exact: true }).first(),
    );
    await collapse.click();
    const expand = page
      .getByRole("button", { name: "Expand", exact: true })
      .first();
    await assertTouchTarget(expand);
    await expand.click();
    await expect(collapse).toBeVisible();
    const lastTickBox = await readBox(
      page.locator("[data-outline-ticks] button").last(),
    );
    const composerBox = await readBox(page.getByTestId("composer"));
    expect(lastTickBox.y + lastTickBox.height).toBeLessThanOrEqual(
      composerBox.y,
    );
  });
});

test("disclosure icon mirrors with RTL chrome", async ({ page }) => {
  await openFixture(page, "popover");
  const icon = page
    .getByRole("button", { name: "Document outline", exact: true })
    .locator("svg");
  expect(
    await icon.evaluate((element) => getComputedStyle(element).scale),
  ).toBe("none");
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
  await expect
    .poll(async () =>
      icon.evaluate((element) => getComputedStyle(element).scale),
    )
    .toBe("-1 1");
});
