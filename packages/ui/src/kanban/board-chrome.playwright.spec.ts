import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const fixturePath = "/src/kanban/fixtures/board-chrome.fixture.html";

/** Sub-pixel layout rounding, not a caption that drifted off the edge. */
const TOLERANCE_PX = 1;

/** `KANBAN_COLUMN_WIDTH_PX`, the unit this suite scrolls the board by. */
const COLUMN_WIDTH_PX = 300;

// A hovering pointer, which the suite's default device does not have: with a
// coarse pointer the hover-revealed actions are shown at all times, and the
// test asserting they appear would pass without ever revealing anything.
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
