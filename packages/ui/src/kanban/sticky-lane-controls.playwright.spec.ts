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
 * lane carries its own row, a pinned action per open column, and a caption per
 * folded band, so each control is read inside the lane it belongs to.
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
    row: section.locator("[data-kanban-lane-row]"),
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

/** Resting on what is pinned above: the control's top edge is that bottom. */
const expectRestingUnder = async (control: Locator, pinnedBottom: number) => {
  expect(Math.abs((await topOf(control)) - pinnedBottom)).toBeLessThanOrEqual(
    TOLERANCE_PX,
  );
};

test.describe("sticky lane controls", () => {
  test("holds a lane's row on the header and its controls under that row", async ({
    page,
  }) => {
    const board = await openFixture(page);
    const header = page.locator("[data-kanban-board-header]");
    const { action, caption, plainAction, row } = laneControls(page, 0);

    // Unscrolled, all of them sit where the lane starts: below the header,
    // not on it.
    expect(await topOf(row)).toBeGreaterThan(await bottomOf(header));
    expect(await topOf(action)).toBeGreaterThan(await bottomOf(header));
    expect(await topOf(caption)).toBeGreaterThan(await bottomOf(header));

    await scrollTo(board, 600);

    // The lane's own row is what comes to rest on the board's header...
    await expectRestingUnder(row, await bottomOf(header));
    // ...and everything the lane pins comes to rest under that row, rather
    // than behind it.
    const rowBottom = await bottomOf(row);
    await expectRestingUnder(action, rowBottom);
    await expectRestingUnder(caption, rowBottom);
    await expectRestingUnder(plainAction, rowBottom);
    // The lane row and both cells: the accented one and the one on the
    // neutral resting surface.
    await expectOpaque(row);
    await expectOpaque(action);
    await expectOpaque(plainAction);
    // Over that base, the row repaints the cell's own accent wash.
    expect(
      await action
        .locator("> div")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("keeps a lane's per-column summaries in its row while the lane is open", async ({
    page,
  }) => {
    const board = await openFixture(page);
    const { row } = laneControls(page, 0);
    // The fixture keeps every lane open; the summaries used to appear only
    // once a lane was collapsed, which is exactly when nobody needs them.
    const summaries = row.locator("[data-kanban-lane-column-count]");

    await scrollTo(board, 600);

    expect(await summaries.count()).toBeGreaterThan(0);
    await expect(summaries.first()).toBeVisible();
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

    // The lane that ended took its row and its controls with it...
    expect(await topOf(scrolled.row)).toBeLessThan(headerBottom);
    expect(await topOf(scrolled.action)).toBeLessThan(headerBottom);
    expect(await topOf(scrolled.caption)).toBeLessThan(headerBottom);
    // ...and the lane now under the header holds its own.
    await expectRestingUnder(next.row, headerBottom);

    const nextRowBottom = await bottomOf(next.row);
    await expectRestingUnder(next.action, nextRowBottom);
    await expectRestingUnder(next.caption, nextRowBottom);
  });
});
