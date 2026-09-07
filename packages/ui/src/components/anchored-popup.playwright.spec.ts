import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/src/components/fixtures/anchored-popup.fixture.html";

const VIEWPORT = { width: 1280, height: 800 };
const SIDES = ["top", "bottom", "left", "right"] as const;
const COMPONENTS = ["tooltip", "popover"] as const;

type Side = (typeof SIDES)[number];
type Component = (typeof COMPONENTS)[number];

test.use({
  viewport: VIEWPORT,
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

const openFixture = async (page: Page, side: Side) => {
  await page.goto(`${fixturePath}?side=${side}`);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["anchoredPopupReady"] ?? "",
        ),
    )
    .toBe("true");
};

const open = {
  tooltip: async (page: Page) => {
    await page.getByText("Version row").hover();
  },
  popover: async (page: Page) => {
    await page.getByRole("button", { name: "Open" }).click();
  },
} as const satisfies Record<Component, (page: Page) => Promise<void>>;

// Base UI positions and collision-tests the positioner, so the popup only
// stays on screen when the positioner's box is the popup's box. Both animate
// on open (the popup scales in, the tooltip positioner transitions its
// offsets), so poll until the two boxes agree, then measure once.
const expectPopupInsideViewport = async (page: Page, component: Component) => {
  const popup = page.locator(`[data-slot="${component}-popup"]`);
  const positioner = page.locator(`[data-slot="${component}-positioner"]`);
  await expect(popup).toBeVisible();

  await expect
    .poll(async () => {
      const positionerBox = await positioner.boundingBox();
      const popupBox = await popup.boundingBox();
      if (!positionerBox || !popupBox) {
        return null;
      }
      return {
        dx: Math.round(popupBox.x - positionerBox.x),
        dy: Math.round(popupBox.y - positionerBox.y),
        dw: Math.round(popupBox.width - positionerBox.width),
        dh: Math.round(popupBox.height - positionerBox.height),
      };
    })
    .toEqual({ dx: 0, dy: 0, dw: 0, dh: 0 });

  const box = await popup.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect(box?.y).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(VIEWPORT.width);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(
    VIEWPORT.height,
  );

  // A popup painted past the edge widens the document, which scrolls the
  // whole page sideways to make room.
  const horizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(horizontalOverflow).toBe(0);
};

for (const component of COMPONENTS) {
  for (const side of SIDES) {
    test(`keeps a ${component} on side ${side} inside the viewport`, async ({
      page,
    }) => {
      await openFixture(page, side);
      await open[component](page);
      await expectPopupInsideViewport(page, component);
    });
  }
}
