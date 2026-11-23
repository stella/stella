/**
 * A PDF fitted to its pane's width shows the whole page.
 *
 * The page fills the width less a gutter on each side: the overlay scrollbar
 * paints over the content at the inline end instead of taking space from it,
 * so a page as wide as the viewport runs under it, and past the column's own
 * padding. The zoom controls float over the pane's top corner, so the first
 * page starts below them. Both are layout facts, measured on the bench at
 * `/dev?visual=pdf-fit-width`: landscape pages, the widest a filed page gets
 * relative to its height, in a pane at the inspector's default width and in a
 * wide one.
 *
 * Every project runs this, `ar` (RTL) included, where the scrollbar and the
 * controls sit at the other edge.
 */

import type { Page } from "@playwright/test";

import { PDF_PAGE_INLINE_INSET_PX } from "../../src/lib/pdf/pdf-fit-width.logic";
import {
  expect,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

const PANE = "[data-pdf-fit-pane]";
const PANE_NAMES = ["inspector", "wide"];

/** Sub-pixel layout rounding; the page width itself rounds down to a device pixel. */
const TOLERANCE_PX = 1;

type Box = { left: number; right: number; top: number; bottom: number };

type PaneGeometry = {
  name: string;
  viewport: Box & { clientWidth: number; scrollWidth: number };
  page: Box & { width: number };
  scrollbar: Box | null;
  bar: Box;
  pagesDrawn: number;
};

const readGeometry = async (page: Page): Promise<PaneGeometry[]> => {
  await waitForStableGeometry(page, page.locator(PANE));
  return await page.evaluate((paneSelector) => {
    const box = (element: Element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    return [...document.querySelectorAll(paneSelector)].map((pane) => {
      const viewport = pane.querySelector('[data-slot="scroll-area-viewport"]');
      const firstPage = pane.querySelector("[data-page-id]");
      const bar = pane.querySelector('[data-slot="viewer-overlay-bar"]');
      const scrollbar = pane.querySelector(
        '[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]',
      );
      if (
        !(pane instanceof HTMLElement) ||
        !(viewport instanceof HTMLElement) ||
        firstPage === null ||
        bar === null
      ) {
        throw new TypeError("PDF fit bench is missing its viewer or controls");
      }
      return {
        name: pane.dataset["pdfFitPane"] ?? "",
        viewport: {
          ...box(viewport),
          clientWidth: viewport.clientWidth,
          scrollWidth: viewport.scrollWidth,
        },
        page: { ...box(firstPage), width: firstPage.clientWidth },
        scrollbar: scrollbar === null ? null : box(scrollbar),
        bar: box(bar),
        pagesDrawn: pane.querySelectorAll("[data-page-id] canvas").length,
      };
    });
  }, PANE);
};

test("a landscape page fitted to the pane's width is never clipped or covered", async ({
  page,
}) => {
  await page.goto("/dev?visual=pdf-fit-width", { waitUntil: "commit" });
  await expect(page.locator(PANE)).toHaveCount(PANE_NAMES.length);
  // Ready once every pane has drawn its first page, not at the load event.
  for (const name of PANE_NAMES) {
    await expect(
      page.locator(
        `${PANE}[data-pdf-fit-pane="${name}"] [data-page-id] canvas`,
      ),
    ).not.toHaveCount(0);
  }

  const panes = await readGeometry(page);
  expect(panes.map((pane) => pane.name)).toEqual(PANE_NAMES);

  for (const {
    bar,
    name,
    page: sheet,
    pagesDrawn,
    scrollbar,
    viewport,
  } of panes) {
    expect(pagesDrawn, `${name}: drew a page`).toBeGreaterThan(0);

    // Still a fit: the page takes the pane's width less the two gutters,
    // not some smaller size that would pass every check below.
    expect(sheet.width, `${name}: page fits the width`).toBeGreaterThanOrEqual(
      viewport.clientWidth - 2 * PDF_PAGE_INLINE_INSET_PX - TOLERANCE_PX,
    );

    // Not clipped: nothing to scroll sideways, and the gutter on each side.
    expect(
      viewport.scrollWidth,
      `${name}: scrolls sideways`,
    ).toBeLessThanOrEqual(viewport.clientWidth + TOLERANCE_PX);
    expect(
      sheet.left - viewport.left,
      `${name}: gutter at the left`,
    ).toBeGreaterThanOrEqual(PDF_PAGE_INLINE_INSET_PX - TOLERANCE_PX);
    expect(
      viewport.right - sheet.right,
      `${name}: gutter at the right`,
    ).toBeGreaterThanOrEqual(PDF_PAGE_INLINE_INSET_PX - TOLERANCE_PX);

    // Not covered by the scrollbar, at whichever edge it sits.
    if (scrollbar !== null) {
      const clear =
        scrollbar.left >= sheet.right - TOLERANCE_PX ||
        scrollbar.right <= sheet.left + TOLERANCE_PX;
      expect(clear, `${name}: scrollbar over the page`).toBe(true);
    }

    // Not covered by the floating zoom controls at the top of the scroll.
    expect(
      sheet.top,
      `${name}: first page starts below the zoom controls`,
    ).toBeGreaterThanOrEqual(bar.bottom);
  }
});
