import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const fixturePath = "/src/kanban/fixtures/board-chrome.fixture.html";

/** Sub-pixel layout rounding, not a caption that drifted off the edge. */
const TOLERANCE_PX = 1;

/** `KANBAN_COLUMN_WIDTH_PX`, the unit this suite scrolls the board by. */
const COLUMN_WIDTH_PX = 300;

// A hovering pointer, which the suite's default device does not have: the
// hover-revealed actions never appear without one, so every test below that
// waits for them would sit there until it timed out.
test.use({
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

const openFixture = async (page: Page) => {
  await page.goto(fixturePath);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            document.documentElement.dataset["kanbanBoardChromeReady"] ?? "",
        ),
    )
    .toBe("true");
  return page.locator(".fixture-board");
};

const leftOf = async (locator: Locator) =>
  await locator.evaluate((element) => element.getBoundingClientRect().left);

const rightOf = async (locator: Locator) =>
  await locator.evaluate((element) => element.getBoundingClientRect().right);

/**
 * The inline-start edge of what the board actually shows: a sticky child
 * comes to rest against the scroll container's content box, inside the
 * board's own inline padding.
 */
const contentLeftOf = async (board: Locator) =>
  await board.evaluate((element) => {
    const padding = Number.parseFloat(
      getComputedStyle(element).paddingInlineStart,
    );
    return element.getBoundingClientRect().left + element.clientLeft + padding;
  });

const scrollInlineTo = async (board: Locator, left: number) => {
  await board.evaluate((element, value) => {
    element.scrollLeft = value;
  }, left);
  await board.page().evaluate(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve(null);
      });
    });
  });
};

const opacityOf = async (locator: Locator) =>
  await locator.evaluate((element) => getComputedStyle(element).opacity);

test.describe("band caption on a board scrolled sideways", () => {
  test("holds the visible edge until the band it names is gone", async ({
    page,
  }) => {
    const board = await openFixture(page);
    const caption = page.locator("[data-kanban-band-caption]").first();
    const bandCell = page
      .locator('[data-kanban-band-row] [data-kanban-band="todo"]')
      .first();

    const contentLeft = await contentLeftOf(board);
    const scrolled = COLUMN_WIDTH_PX * 1.5;

    // Unscrolled, the caption leads its own band, where it was written.
    expect(
      Math.abs((await leftOf(caption)) - (await leftOf(bandCell))),
    ).toBeLessThanOrEqual(TOLERANCE_PX);

    // Past the first column, with the band's second column still on screen.
    await scrollInlineTo(board, scrolled);

    // The band moved with the board, and its second column is still shown...
    expect(
      Math.abs((await leftOf(bandCell)) - (contentLeft - scrolled)),
    ).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(await rightOf(bandCell)).toBeGreaterThan(contentLeft);
    // ...while its caption travelled the same distance the other way, to hold
    // the edge the reader is actually looking at.
    expect(Math.abs((await leftOf(caption)) - contentLeft)).toBeLessThanOrEqual(
      TOLERANCE_PX,
    );
    expect(
      Math.abs((await leftOf(caption)) - (await leftOf(bandCell)) - scrolled),
    ).toBeLessThanOrEqual(TOLERANCE_PX);

    // Once the band itself is behind us, the caption leaves with it rather
    // than naming whatever column happens to be under it now.
    await scrollInlineTo(board, COLUMN_WIDTH_PX * 2.5);

    expect(await rightOf(bandCell)).toBeLessThan(contentLeft);
    expect(await rightOf(caption)).toBeLessThanOrEqual(contentLeft);
  });
});

test.describe("hover-revealed card actions", () => {
  test("reveals them on the card under the pointer and lets them be hit", async ({
    page,
  }) => {
    await openFixture(page);
    const card = page.locator('[data-card="open-1"]');
    const actions = card.locator('[data-kanban-card-actions="hover"]');

    expect(await opacityOf(actions)).toBe("0");

    await card.hover();

    // The reveal is a transition, so it lands a frame or two later.
    await expect.poll(async () => await opacityOf(actions)).toBe("1");

    // Visible is not the same as usable: the pinned identity row leads the
    // same corner, so the trigger has to be what the pointer actually finds.
    const hit = await actions.evaluate((element) => {
      const { left, top, width, height } = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(left + width / 2, top + height / 2),
      );
    });

    expect(hit).toBe(true);
  });

  test("leaves the actions of the cards the pointer is not on hidden", async ({
    page,
  }) => {
    await openFixture(page);
    const hovered = page
      .locator('[data-card="open-1"] [data-kanban-card-actions="hover"]')
      .first();
    const other = page
      .locator('[data-card="blocked-1"] [data-kanban-card-actions="hover"]')
      .first();

    await page.locator('[data-card="open-1"]').hover();
    await expect.poll(async () => await opacityOf(hovered)).toBe("1");

    expect(await opacityOf(other)).toBe("0");
  });
});

test.describe("hover-revealed card actions on a touch device", () => {
  // A finger, which has no hover at all: the case the overlay used to show
  // itself for, and the one where an overlay that answers a press costs the
  // card the gesture.
  test.use({ hasTouch: true, isMobile: true });

  /**
   * What a finger finds at the dead centre of the overlay's own box — the
   * corner a card is pressed and dragged from, and the corner the actions
   * appear in. Reported as both memberships, because the overlay sits inside
   * the card: "inside the card" alone would be true either way.
   */
  const whatIsAtTheCorner = async (actions: Locator) =>
    await actions.evaluate((element) => {
      const { left, top, width, height } = element.getBoundingClientRect();
      const found = document.elementFromPoint(
        left + width / 2,
        top + height / 2,
      );
      const body = element.closest("[data-card]");

      return {
        insideActions: element.contains(found),
        insideCard: body?.contains(found) ?? false,
      };
    });

  test("gives the corner to the card at rest and to the actions once it opens", async ({
    page,
  }) => {
    await openFixture(page);
    const card = page.locator('[data-card="open-1"]');
    const actions = card.locator('[data-kanban-card-actions="hover"]');

    // At rest the corner belongs to the card, so a press there is the card's
    // to act on rather than the hidden overlay's to swallow.
    const atRest = await whatIsAtTheCorner(actions);

    expect(atRest.insideActions).toBe(false);
    expect(atRest.insideCard).toBe(true);

    // A tap on that same corner therefore reaches the card and opens it...
    const box = await actions.boundingBox();

    expect(box).not.toBeNull();
    await page.touchscreen.tap(
      (box?.x ?? 0) + (box?.width ?? 0) / 2,
      (box?.y ?? 0) + (box?.height ?? 0) / 2,
    );

    // ...and the open card is a finger's way to the actions: it has no hover
    // to reveal them with and no tab key to focus them by.
    await expect.poll(async () => await opacityOf(actions)).toBe("1");

    const opened = await whatIsAtTheCorner(actions);

    expect(opened.insideActions).toBe(true);
  });

  test("leaves the cards a tap did not open alone", async ({ page }) => {
    await openFixture(page);
    const opened = page
      .locator('[data-card="open-1"] [data-kanban-card-actions="hover"]')
      .first();
    const other = page
      .locator('[data-card="blocked-1"] [data-kanban-card-actions="hover"]')
      .first();

    await page.locator('[data-card="open-1"]').tap();
    await expect.poll(async () => await opacityOf(opened)).toBe("1");

    // Every card carries this overlay; only the open one may show it, or the
    // board grows the dead corner back on all the others.
    expect(await opacityOf(other)).toBe("0");
    expect((await whatIsAtTheCorner(other)).insideActions).toBe(false);
  });
});
