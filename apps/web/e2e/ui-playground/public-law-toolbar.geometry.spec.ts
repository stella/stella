/**
 * The public-law results toolbar's geometry.
 *
 * On a narrow pane the toolbar once squeezed its summary ("Page 1 · about N
 * results · Results for: …") into the sliver the controls left, so the query
 * broke word by word and ran under the controls' icons. Whether the summary
 * keeps a readable width and stays clear of every control is true by layout
 * or not at all, so it is measured here on the bench at
 * `/dev?visual=public-law-toolbar`, which mounts the product's own toolbar at a
 * phone, a split-pane and a desktop width.
 */

import type { Page } from "@playwright/test";

import {
  expect,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

/** Mirrors PUBLIC_LAW_TOOLBAR_BENCH_WIDTHS; the spec stays out of the app graph. */
const BENCH_WIDTHS = [360, 600, 1024] as const;

/** Below this toolbar width the summary takes a row of its own (`@2xl`). */
const OWN_ROW_BELOW_PX = 672;

/** The summary's floor width once it shares the row (`min-w-56`). */
const SHARED_ROW_FLOOR_PX = 224;

const TOLERANCE_PX = 1;

type Box = { top: number; bottom: number; left: number; right: number };

type ToolbarGeometry = {
  toolbar: Box;
  summary: Box;
  controls: Box[];
  resultsLine: {
    height: number;
    lineHeight: number;
    clientWidth: number;
    scrollWidth: number;
    textOverflow: string;
    title: string | null;
  };
};

const readGeometry = async (page: Page, width: number) => {
  const toolbarLocator = page.locator(
    `[data-playground-section="public-law-toolbar:${width}"]`,
  );
  await waitForStableGeometry(page, toolbarLocator);
  return await page.evaluate((benchWidth): ToolbarGeometry => {
    const section = document.querySelector(
      `[data-playground-section="public-law-toolbar:${benchWidth}"]`,
    );
    const toolbar = section?.querySelector(
      '[data-slot="public-law-results-toolbar"]',
    );
    const summary = toolbar?.querySelector(
      '[data-slot="public-law-results-summary"]',
    );
    const resultsLine = summary?.querySelector("p[title]");
    if (
      !(toolbar instanceof HTMLElement) ||
      !(summary instanceof HTMLElement) ||
      !(resultsLine instanceof HTMLElement)
    ) {
      throw new Error("public-law toolbar bench is not mounted");
    }
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      };
    };
    const style = getComputedStyle(resultsLine);
    return {
      toolbar: box(toolbar),
      summary: box(summary),
      controls: [...toolbar.querySelectorAll("button, [role='combobox']")].map(
        box,
      ),
      resultsLine: {
        height: resultsLine.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        clientWidth: resultsLine.clientWidth,
        scrollWidth: resultsLine.scrollWidth,
        textOverflow: style.textOverflow,
        title: resultsLine.getAttribute("title"),
      },
    };
  }, width);
};

const overlaps = (a: Box, b: Box) =>
  a.left < b.right - TOLERANCE_PX &&
  b.left < a.right - TOLERANCE_PX &&
  a.top < b.bottom - TOLERANCE_PX &&
  b.top < a.bottom - TOLERANCE_PX;

test.beforeEach(async ({ page }) => {
  await page.goto("/dev?visual=public-law-toolbar", {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.locator('[data-slot="public-law-results-toolbar"]'),
  ).toHaveCount(BENCH_WIDTHS.length);
});

for (const width of BENCH_WIDTHS) {
  test(`keeps the summary readable and clear of the controls at ${width}px`, async ({
    page,
  }) => {
    const geometry = await readGeometry(page, width);
    const toolbarWidth = geometry.toolbar.right - geometry.toolbar.left;
    const summaryWidth = geometry.summary.right - geometry.summary.left;

    expect(geometry.controls.length).toBeGreaterThan(0);
    for (const control of geometry.controls) {
      expect(overlaps(geometry.summary, control)).toBe(false);
    }

    if (toolbarWidth < OWN_ROW_BELOW_PX) {
      // Its own full row, above every control.
      expect(summaryWidth).toBeGreaterThanOrEqual(toolbarWidth - TOLERANCE_PX);
      for (const control of geometry.controls) {
        expect(geometry.summary.bottom).toBeLessThanOrEqual(
          control.top + TOLERANCE_PX,
        );
      }
    } else {
      expect(summaryWidth).toBeGreaterThanOrEqual(
        SHARED_ROW_FLOOR_PX - TOLERANCE_PX,
      );
    }

    // A long query ends in an ellipsis on one line; the title keeps it whole.
    const line = geometry.resultsLine;
    expect(line.height).toBeLessThanOrEqual(line.lineHeight + TOLERANCE_PX);
    expect(line.textOverflow).toBe("ellipsis");
    expect(line.title?.length ?? 0).toBeGreaterThan(0);
    if (toolbarWidth < OWN_ROW_BELOW_PX) {
      expect(line.scrollWidth).toBeGreaterThan(line.clientWidth);
    }
  });
}
