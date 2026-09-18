import { expect, test, type Page } from "@playwright/test";

const fixturePath = "/src/components/fixtures/anchored-popup.fixture.html";

const VIEWPORT = { width: 1280, height: 800 };
const SIDES = ["top", "bottom", "left", "right"] as const;
const COMPONENTS = ["tooltip", "popover"] as const;
// The fixture pins one select trigger to each of these viewport edges.
const EDGES = ["top", "bottom"] as const;

type Side = (typeof SIDES)[number];
type Component = (typeof COMPONENTS)[number];
type Edge = (typeof EDGES)[number];

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

// The side each request resolves to once collision handling has run. The
// triggers sit at the inline end of the viewport, so `right` has no room and
// flips; every other side keeps what it asked for. Asserting the resolved side
// is what separates "the popup is on screen because it was placed correctly"
// from "the popup is on screen because it never left the default side".
const RESOLVED_SIDE = {
  top: "top",
  bottom: "bottom",
  left: "left",
  right: "left",
} as const satisfies Record<Side, Side>;

// Base UI positions and collision-tests the positioner, so the popup only
// stays on screen when the positioner's box is the popup's box. Both animate
// on open (the popup scales in, the tooltip positioner transitions its
// offsets), so poll until the two boxes agree, then measure once.
const expectPopupInsideViewport = async (
  page: Page,
  component: Component | "select",
  resolvedSide: Side,
) => {
  const popup = page.locator(`[data-slot="${component}-popup"]`);
  const positioner = page.locator(`[data-slot="${component}-positioner"]`);
  await expect(popup).toBeVisible();
  await expect(positioner).toHaveAttribute("data-side", resolvedSide);

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
      await expectPopupInsideViewport(page, component, RESOLVED_SIDE[side]);
    });
  }
}

// A select trigger within 20px of an edge makes Base UI give up aligning the
// chosen item over the trigger and place the list like a dropdown. The
// dropdown then has room on the far side only, so it must resolve there; a
// list that stays on the requested side shrinks to the space left, which is
// none.
const EDGE_RESOLVED_SIDE = {
  top: "bottom",
  bottom: "top",
} as const satisfies Record<Edge, Side>;

for (const edge of EDGES) {
  test(`keeps a select opened at the ${edge} edge inside the viewport`, async ({
    page,
  }) => {
    await openFixture(page, "top");
    await page
      .getByRole("combobox", { name: `Page size at ${edge} edge` })
      .click();
    await expectPopupInsideViewport(page, "select", EDGE_RESOLVED_SIDE[edge]);

    // Every option fits on screen, so the list must show them all rather
    // than scroll a sliver of itself.
    const list = page.locator('[data-slot="select-list"]');
    const overflow = await list.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    expect(overflow).toBe(0);
  });
}
