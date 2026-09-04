import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const fixturePath = "/src/kanban/fixtures/card-sticky-header.fixture.html";

/** Sub-pixel layout rounding, not a row that drifted off what pinned it. */
const TOLERANCE_PX = 1;

const openFixture = async (page: Page) => {
  await page.goto(fixturePath);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            document.documentElement.dataset["kanbanCardStickyHeaderReady"] ??
            "",
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

const card = (page: Page, id: string) => page.locator(`[data-card="${id}"]`);

const headerOf = (page: Page, id: string) =>
  card(page, id).locator("[data-kanban-card-sticky-header]");

/** The lane's own pinned action: what a card's header comes to rest under. */
const pinnedAction = (page: Page) =>
  page.locator('[data-kanban-cell-footer="sticky-start"]').first();

/** Resting where it was pinned: the row's top edge is the action's bottom. */
const expectRestingOnAction = async (header: Locator, actionBottom: number) => {
  expect(Math.abs((await topOf(header)) - actionBottom)).toBeLessThanOrEqual(
    TOLERANCE_PX,
  );
};

/** How far the row was told to pin, out of `calc(var(...) + Npx)`. */
const pinnedAboveOf = (offset: string) => {
  const match = /\+\s*(?<pixels>\d+(?:\.\d+)?)px/u.exec(offset);

  return match?.groups ? Number(match.groups["pixels"]) : 0;
};

test.describe("card sticky header", () => {
  test("carries the action's reach on the board's first layout", async ({
    page,
  }) => {
    await openFixture(page);
    // Read in the frame the row is first painted in: a measurement left to an
    // observer leaves this at the bare board offset, and every card's row
    // spends that frame pinned where the action is about to be.
    const firstLayout = await page.evaluate(
      () => document.documentElement.dataset["kanbanCardStickyTopFirstLayout"],
    );

    expect(firstLayout).toBeDefined();
    expect(pinnedAboveOf(firstLayout ?? "")).toBeGreaterThan(0);
    // And it is the action's own height, not some arbitrary offset.
    const actionHeight = await pinnedAction(page).evaluate(
      (element) => element.getBoundingClientRect().height,
    );

    expect(
      Math.abs(pinnedAboveOf(firstLayout ?? "") - actionHeight),
    ).toBeLessThanOrEqual(TOLERANCE_PX);
  });

  test("holds a card's identity row under the lane's pinned action", async ({
    page,
  }) => {
    const board = await openFixture(page);
    const action = pinnedAction(page);
    const first = headerOf(page, "card-1");

    // Unscrolled, the row sits where its card starts: below the action, not
    // on it.
    expect(await topOf(first)).toBeGreaterThan(await bottomOf(action));

    // Mid-way down a card taller than the board's viewport.
    await scrollTo(board, 300);
    await expectRestingOnAction(first, await bottomOf(action));

    // Everything pinned above the card, in order: the board's header, then
    // the lane's own row, then the cell's action, then this row. A card that
    // counted only the action would park its row behind the lane row.
    const header = page.locator("[data-kanban-board-header]");
    const laneRow = page.locator("[data-kanban-lane-row]").first();

    expect(
      Math.abs((await topOf(laneRow)) - (await bottomOf(header))),
    ).toBeLessThanOrEqual(TOLERANCE_PX);
    expect(
      Math.abs((await topOf(action)) - (await bottomOf(laneRow))),
    ).toBeLessThanOrEqual(TOLERANCE_PX);

    // The card passes behind the row rather than reading through it.
    const background = await first.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );

    expect(background).not.toBe("rgba(0, 0, 0, 0)");
    expect(background).not.toContain("/");
  });

  test("releases the row where its card ends and hands over to the next", async ({
    page,
  }) => {
    const board = await openFixture(page);
    const action = pinnedAction(page);
    const first = headerOf(page, "card-1");
    const second = headerOf(page, "card-2");

    const boardTop = await topOf(board);
    const secondTop = await topOf(card(page, "card-2"));
    // Well inside the second card, so the first one is behind us.
    await scrollTo(board, secondTop - boardTop + 300);

    const actionBottom = await bottomOf(action);

    // The card that ended took its row with it...
    expect(await topOf(first)).toBeLessThan(actionBottom);
    // ...and the card now under the action holds its own.
    await expectRestingOnAction(second, actionBottom);
  });

  test("leaves the card's actions overlay on top of the row", async ({
    page,
  }) => {
    await openFixture(page);
    const actions = page.locator('[data-card-actions="card-1"]');

    // At rest the row leads the very corner the overlay is anchored to, so a
    // stacking layer on the row would paint over the trigger and take its
    // clicks.
    const hit = await actions.evaluate((element) => {
      const { left, top, width, height } = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(left + width / 2, top + height / 2),
      );
    });

    expect(hit).toBe(true);
  });

  test("keeps the row with its card while the card is the drag source", async ({
    page,
  }) => {
    const board = await openFixture(page);
    const first = card(page, "card-1");
    const header = headerOf(page, "card-1");

    await scrollTo(board, 300);
    const pinnedTop = await topOf(header);

    // The transform `useKanbanSortable` puts on the active drag source. The
    // row must ride with the card instead of staying behind on the action.
    await first.evaluate((element) => {
      element.style.transform = "translate3d(0px, -80px, 0)";
    });
    await scrollTo(board, 300);

    expect(
      Math.abs((await topOf(header)) - (pinnedTop - 80)),
    ).toBeLessThanOrEqual(TOLERANCE_PX);
  });
});
