import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const fixturePath = "/src/kanban/fixtures/sticky-lane-controls.fixture.html";

/** Sub-pixel layout rounding, not a control that drifted off the header. */
const TOLERANCE_PX = 1;

const openFixture = async (page: Page) => {
  await page.goto(fixturePath);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["kanbanStickyLaneReady"] ?? "",
        ),
    )
    .toBe("true");
  return page.locator(".fixture-board");
};

const topOf = async (locator: Locator) =>
  await locator.evaluate((element) => element.getBoundingClientRect().top);

const bottomOf = async (locator: Locator) =>
  await locator.evaluate((element) => element.getBoundingClientRect().bottom);

const scrollTo = async (board: Locator, top: number) => {
  await board.evaluate((element, value) => {
    element.scrollTop = value;
  }, top);
  await board.page().evaluate(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        resolve(null);
      });
    });
  });
};

/**
 * One lane's own pinned controls. The board renders a lane per section, and a
 * lane carries a pinned action per open column and a caption per folded band,
 * so each control is read inside the lane it belongs to.
 */
const laneControls = (page: Page, lane: number) => {
  const section = page.locator("section").nth(lane);
  const actions = section.locator('[data-kanban-cell-footer="sticky-start"]');
  return {
    // The lane's first open column carries an accent wash; the uncategorized
    // one behind it rests on the neutral surface.
    action: actions.first(),
    caption: section.locator("[data-kanban-collapsed-band-caption]").first(),
    plainAction: actions.nth(1),
  };
};

/** Cards must pass behind a pinned control, never read through it. */
const expectOpaque = async (control: Locator) => {
  const background = await control.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  // A serialized alpha channel would let the cards read through the control.
  expect(background).not.toContain("/");
};

/** Resting on the header: the control's top edge is the header's bottom. */
const expectRestingOnHeader = async (
  control: Locator,
  headerBottom: number,
) => {
  expect(Math.abs((await topOf(control)) - headerBottom)).toBeLessThanOrEqual(
    TOLERANCE_PX,
  );
};

test.describe("sticky lane controls", () => {
  test("holds a lane's action and folded caption under the board header", async ({
    page,
  }) => {
    const board = await openFixture(page);
    const header = page.locator("[data-kanban-board-header]");
    const { action, caption, plainAction } = laneControls(page, 0);

    // Unscrolled, both sit where the lane starts: below the header, not on it.
    expect(await topOf(action)).toBeGreaterThan(await bottomOf(header));
    expect(await topOf(caption)).toBeGreaterThan(await bottomOf(header));

    await scrollTo(board, 600);

    const headerBottom = await bottomOf(header);
    await expectRestingOnHeader(action, headerBottom);
    await expectRestingOnHeader(caption, headerBottom);
    await expectRestingOnHeader(plainAction, headerBottom);
    // Both the accented cell and the one on the neutral resting surface.
    await expectOpaque(action);
    await expectOpaque(plainAction);
    // Over that base, the row repaints the cell's own accent wash.
    expect(
      await action
        .locator("> div")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("releases them where the lane ends and hands over to the next", async ({
    page,
  }) => {
    const board = await openFixture(page);
    const header = page.locator("[data-kanban-board-header]");
    const scrolled = laneControls(page, 0);
    const next = laneControls(page, 1);

    const boardTop = await topOf(board);
    const nextLaneTop = await topOf(page.locator("section").nth(1));
    // Well inside the second lane, so the first lane's controls are behind us.
    await scrollTo(board, nextLaneTop - boardTop + 400);

    const headerBottom = await bottomOf(header);

    // The lane that ended took its controls with it...
    expect(await topOf(scrolled.action)).toBeLessThan(headerBottom);
    expect(await topOf(scrolled.caption)).toBeLessThan(headerBottom);
    // ...and the lane now under the header holds its own.
    await expectRestingOnHeader(next.action, headerBottom);
    await expectRestingOnHeader(next.caption, headerBottom);
  });
});
