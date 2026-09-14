/**
 * The workspace table's geometry.
 *
 * Four things about the shared table are true by layout or not at all, and none
 * of them survives a unit test: the table scrolls inside the height its host
 * gives it, the header freezes while the body scrolls under it, a pinned column
 * freezes at the same inline offset in the header as in every row, and a column
 * is one width in the header and in the body. They are measured here on the
 * bench at `/dev?visual=workspace-table`, which mounts the product's own
 * results table.
 *
 * Every project runs them, so the inline-axis assertions are made under `ar`
 * (RTL) as well: the comparisons are between two boxes of the same table, which
 * holds whichever edge the inline start is.
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const SECTION = '[data-playground-section="workspace-table"]';
const SCROLL_BOX = `${SECTION} [data-slot="workspace-table-scroll"]`;
const HEADER_CELL = `${SECTION} [data-slot="workspace-grid-head"]`;
const BODY_ROW = `${SECTION} [data-slot="workspace-grid-row"][data-index]`;

/** The column pinned past the checkbox, so its offset is not zero. */
const PINNED_COLUMN_INDEX = 2;

/** How far a row's box may differ from its tallest cell before it is clipping. */
const BOX_TOLERANCE_PX = 1;

type CellBox = {
  inlineOffset: number;
  blockOffset: number;
  width: number;
  height: number;
};

type TableGeometry = {
  scroll: {
    scrollLeft: number;
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
    clientWidth: number;
    scrollWidth: number;
  };
  renderedRowCount: number;
  headerCells: CellBox[];
  firstRowCells: CellBox[];
};

const readGeometry = async (page: Page) =>
  page.evaluate(
    ([sectionSelector, scrollSelector]): TableGeometry => {
      const section = document.querySelector(sectionSelector);
      const scroll = section?.querySelector(scrollSelector);
      if (
        !(section instanceof HTMLElement) ||
        !(scroll instanceof HTMLElement)
      ) {
        throw new Error("workspace table bench is not mounted");
      }
      const origin = scroll.getBoundingClientRect();
      const box = (element: Element): CellBox => {
        const rect = element.getBoundingClientRect();
        return {
          inlineOffset: Math.round(rect.left - origin.left),
          blockOffset: Math.round(rect.top - origin.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      const rows = [
        ...section.querySelectorAll<HTMLElement>(
          '[data-slot="workspace-grid-row"][data-index]',
        ),
      ];
      const firstRow = rows.find((row) => row.dataset["index"] === "0");
      return {
        scroll: {
          scrollLeft: Math.round(scroll.scrollLeft),
          scrollTop: Math.round(scroll.scrollTop),
          clientHeight: scroll.clientHeight,
          scrollHeight: scroll.scrollHeight,
          clientWidth: scroll.clientWidth,
          scrollWidth: scroll.scrollWidth,
        },
        renderedRowCount: rows.length,
        headerCells: [
          ...section.querySelectorAll('[data-slot="workspace-grid-head"]'),
        ]
          .filter((cell) => cell.hasAttribute("aria-colindex"))
          .map(box),
        firstRowCells: firstRow
          ? [...firstRow.querySelectorAll('[data-slot="workspace-grid-cell"]')]
              .filter((cell) => cell.hasAttribute("aria-colindex"))
              .map(box)
          : [],
      };
    },
    [SECTION, '[data-slot="workspace-table-scroll"]'] as const,
  );

/**
 * Scroll the table's own box to the middle of an axis, or of both.
 */
const scrollToMiddle = async (
  page: Page,
  axes: { inline: boolean; block: boolean },
) => {
  await page.evaluate(
    ([scrollSelector, inline, block]) => {
      const scroll = document.querySelector(scrollSelector);
      if (!(scroll instanceof HTMLElement)) {
        throw new Error("workspace table scroll box is not mounted");
      }
      if (inline) {
        // `scrollLeft` is physical, and under `dir="rtl"` its scrollable range
        // runs from -(overflow) to 0, so the sign has to follow the direction
        // for the same call to move the table off its inline start in both.
        const overflow = (scroll.scrollWidth - scroll.clientWidth) / 2;
        scroll.scrollLeft =
          getComputedStyle(scroll).direction === "rtl" ? -overflow : overflow;
      }
      if (block) {
        scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) / 2;
      }
    },
    [SCROLL_BOX, axes.inline, axes.block] as const,
  );
  // One frame for the sticky offsets to settle before anything is measured.
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(null));
    });
  });
};

test.beforeEach(async ({ page }) => {
  await page.goto("/dev?visual=workspace-table", {
    waitUntil: "domcontentloaded",
  });
  await page.locator(HEADER_CELL).first().waitFor();
  await page.locator(BODY_ROW).first().waitFor();
});

test("the table scrolls inside the height its host gives it", async ({
  page,
}) => {
  const geometry = await readGeometry(page);

  // A table that grew to its rows has no scroll of its own: the header has
  // nothing to freeze against and the virtualizer windows nothing.
  expect(geometry.scroll.scrollHeight).toBeGreaterThan(
    geometry.scroll.clientHeight,
  );
  expect(geometry.scroll.scrollWidth).toBeGreaterThan(
    geometry.scroll.clientWidth,
  );
  expect(geometry.renderedRowCount).toBeLessThan(40);
});

test("the header stays frozen while the body scrolls under it", async ({
  page,
}) => {
  await scrollToMiddle(page, { inline: false, block: true });
  const geometry = await readGeometry(page);

  expect(geometry.scroll.scrollTop).toBeGreaterThan(0);
  const headerCell = geometry.headerCells.at(0);
  const bodyCell = geometry.firstRowCells.at(0);
  expect(headerCell).toBeDefined();
  expect(bodyCell).toBeDefined();
  expect(headerCell?.blockOffset).toBe(0);
  // The body really did move; otherwise a header at 0 proves nothing.
  expect(bodyCell?.blockOffset).toBeLessThan(0);
});

test("a pinned column freezes at one inline offset in the header and the body", async ({
  page,
}) => {
  const atRest = await readGeometry(page);
  await scrollToMiddle(page, { inline: true, block: false });
  const scrolledInline = await readGeometry(page);
  expect(Math.abs(scrolledInline.scroll.scrollLeft)).toBeGreaterThan(0);

  const pinnedHeader = scrolledInline.headerCells.at(PINNED_COLUMN_INDEX - 1);
  const pinnedBody = scrolledInline.firstRowCells.at(PINNED_COLUMN_INDEX - 1);
  expect(pinnedHeader).toBeDefined();
  expect(pinnedBody).toBeDefined();
  expect(pinnedHeader?.inlineOffset).toBe(pinnedBody?.inlineOffset);
  // The pinned column did not move while the first unpinned one did, so the
  // equality above is a frozen column rather than a table that never scrolled.
  expect(pinnedHeader?.inlineOffset).toBe(
    atRest.headerCells.at(PINNED_COLUMN_INDEX - 1)?.inlineOffset,
  );
  const unpinnedTravel = Math.abs(
    (scrolledInline.headerCells.at(PINNED_COLUMN_INDEX)?.inlineOffset ?? 0) -
      (atRest.headerCells.at(PINNED_COLUMN_INDEX)?.inlineOffset ?? 0),
  );
  expect(unpinnedTravel).toBe(Math.abs(scrolledInline.scroll.scrollLeft));

  await scrollToMiddle(page, { inline: false, block: true });
  const scrolledBoth = await readGeometry(page);
  expect(scrolledBoth.scroll.scrollTop).toBeGreaterThan(0);
  expect(
    scrolledBoth.headerCells.at(PINNED_COLUMN_INDEX - 1)?.inlineOffset,
  ).toBe(scrolledBoth.firstRowCells.at(PINNED_COLUMN_INDEX - 1)?.inlineOffset);
  expect(
    scrolledBoth.headerCells.at(PINNED_COLUMN_INDEX - 1)?.blockOffset,
  ).toBe(0);
});

test("a column is one width in the header and in the body", async ({
  page,
}) => {
  await scrollToMiddle(page, { inline: true, block: true });
  const geometry = await readGeometry(page);

  expect(geometry.headerCells.length).toBeGreaterThan(4);
  expect(geometry.firstRowCells.length).toBe(geometry.headerCells.length);
  expect(geometry.firstRowCells.map((cell) => cell.width)).toEqual(
    geometry.headerCells.map((cell) => cell.width),
  );
  expect(geometry.firstRowCells.map((cell) => cell.inlineOffset)).toEqual(
    geometry.headerCells.map((cell) => cell.inlineOffset),
  );
});

test("a row shown whole is as tall as what it holds", async ({ page }) => {
  await page.locator('[data-playground-content-mode="fit-content"]').click();
  // The rows regrow and the virtualizer re-measures them; wait for the first
  // row to exceed the clamped height rather than for a fixed delay.
  await expect
    .poll(async () => {
      const geometry = await readGeometry(page);
      return geometry.firstRowCells.at(0)?.height ?? 0;
    })
    .toBeGreaterThan(48);

  const clipped = await page.evaluate(
    ([bodyRowSelector]) => {
      const row = document.querySelector(`${bodyRowSelector}[data-index="0"]`);
      if (!(row instanceof HTMLElement)) {
        throw new Error("first row is not mounted");
      }
      const cells = [
        ...row.querySelectorAll('[data-slot="workspace-grid-cell"]'),
      ].filter((cell): cell is HTMLElement => cell instanceof HTMLElement);
      return {
        rowHeight: Math.round(row.getBoundingClientRect().height),
        tallestContent: Math.max(...cells.map((cell) => cell.scrollHeight)),
        overflowing: cells
          .filter((cell) => cell.scrollHeight > cell.clientHeight + 1)
          .map((cell) => cell.getAttribute("aria-colindex")),
      };
    },
    [BODY_ROW] as const,
  );

  // The row's box is its content, not a clamp its cells scroll inside.
  expect(clipped.overflowing).toEqual([]);
  expect(
    Math.abs(clipped.rowHeight - clipped.tallestContent),
  ).toBeLessThanOrEqual(BOX_TOLERANCE_PX);
});
