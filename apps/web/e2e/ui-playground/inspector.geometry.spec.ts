/**
 * The inspector pane never scrolls sideways.
 *
 * The pane is resizable, and its inline size belongs to the reader: whatever
 * a court's file contains, dragging the pane narrow must give a narrower
 * column, not a document that scrolls under the reader's hands. That is a
 * layout fact, so it is measured rather than asserted in a unit test, on the
 * bench at `/dev?visual=inspector-pane`, which mounts the product's own
 * reader stack over a document written to break it: a 320-character
 * unbreakable token (an embedded-object identifier that survived ingestion)
 * and a twelve-column schedule.
 *
 * Every project runs this, so it is measured under `ar` (RTL) as well, where
 * the scrollable edge is the other one and a fix that only holds in LTR is a
 * fix that does not hold.
 */

import type { Locator, Page } from "@playwright/test";

import {
  expect,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

const SECTION = '[data-playground-section="inspector-pane"]';
const VIEWPORT = `${SECTION} [data-slot="scroll-area-viewport"]`;

/** The pane's minimum and its default, from `@stll/ui/inspector`. */
const PANE_WIDTHS = [320, 512] as const;

/**
 * The tab rail, from `@stll/ui/inspector`. The dock keeps it inside the pane's
 * width, so the view is measured at 272px when the pane is at its 320px
 * minimum. A bench that gave the view the whole pane would pass while the
 * product overflowed.
 */
const RAIL_WIDTH = 48;

/** Sub-pixel layout rounding is not a horizontal scrollbar. */
const OVERFLOW_TOLERANCE_PX = 1;

type PaneGeometry = {
  paneWidth: number;
  railWidth: number;
  clientWidth: number;
  scrollWidth: number;
  /** Whether the reader actually drew the defect the bench is built on. */
  drewToken: boolean;
  drewTable: boolean;
};

const readGeometry = async (page: Page): Promise<PaneGeometry[]> => {
  await waitForStableGeometry(page, page.locator(SECTION));
  return await page.evaluate((sectionSelector) => {
    const sections = [...document.querySelectorAll(sectionSelector)];
    return sections.map((section) => {
      const viewport = section.querySelector(
        '[data-slot="scroll-area-viewport"]',
      );
      const rail = section.querySelector('[data-slot="inspector-rail"]');
      if (
        !(section instanceof HTMLElement) ||
        !(viewport instanceof HTMLElement)
      ) {
        throw new TypeError(
          "inspector pane bench is missing its scroll viewport",
        );
      }
      if (!(rail instanceof HTMLElement)) {
        throw new TypeError("inspector pane bench is missing its tab rail");
      }
      return {
        paneWidth: Number(section.dataset["paneWidth"]),
        railWidth: rail.offsetWidth,
        clientWidth: viewport.clientWidth,
        scrollWidth: viewport.scrollWidth,
        drewToken: viewport.textContent.includes("lipuid"),
        drewTable: viewport.querySelector("table") !== null,
      };
    });
  }, SECTION);
};

test("the pane's reader never scrolls sideways, at either width", async ({
  page,
}) => {
  await page.goto("/dev?visual=inspector-pane", { waitUntil: "commit" });
  // The bench is ready when both panes have drawn their reader, not when the
  // document load event fires.
  await expect(page.locator(VIEWPORT)).toHaveCount(PANE_WIDTHS.length);
  await expect(page.locator(`${SECTION} table`).first()).toBeVisible();
  await waitForStableGeometry(page, page.locator(SECTION));

  const panes = await readGeometry(page);
  expect(panes.map((pane) => pane.paneWidth).toSorted((a, b) => a - b)).toEqual(
    [...PANE_WIDTHS],
  );

  for (const pane of panes) {
    // The other vacuous pass: a reader measured at the whole pane width has
    // 48px the product does not give it, so it can fit what production
    // overflows.
    expect(
      pane.railWidth,
      `pane ${String(pane.paneWidth)} reserves the rail`,
    ).toBe(RAIL_WIDTH);
    expect(
      pane.clientWidth,
      `pane ${String(pane.paneWidth)} measures the reader beside the rail`,
    ).toBeLessThanOrEqual(pane.paneWidth - RAIL_WIDTH);

    // A vacuous pass is the failure mode this test has to rule out: if the
    // reader drew neither the token nor the table, nothing was under test.
    expect(
      pane.drewToken,
      `pane ${String(pane.paneWidth)} drew the token`,
    ).toBe(true);
    expect(
      pane.drewTable,
      `pane ${String(pane.paneWidth)} drew the table`,
    ).toBe(true);
    expect(
      pane.scrollWidth,
      `pane ${String(pane.paneWidth)} scrolls sideways`,
    ).toBeLessThanOrEqual(pane.clientWidth + OVERFLOW_TOLERANCE_PX);
  }
});

test("a table too wide for the column scrolls inside its own box", async ({
  page,
}) => {
  await page.goto("/dev?visual=inspector-pane", { waitUntil: "commit" });
  await expect(page.locator(`${SECTION} table`).first()).toBeVisible();
  await waitForStableGeometry(page, page.locator(SECTION));

  // The pane holds its width by wrapping what can wrap; a table cannot, so it
  // keeps the axis locally rather than giving it to the document.
  const tableScrollers = await page.evaluate((sectionSelector) => {
    const narrow = document.querySelector(
      `${sectionSelector}[data-pane-width="320"]`,
    );
    const table = narrow?.querySelector("table");
    const box = table?.parentElement;
    if (!(box instanceof HTMLElement)) {
      throw new TypeError("inspector pane bench is missing its table");
    }
    return {
      overflowX: getComputedStyle(box).overflowX,
      scrolls: box.scrollWidth > box.clientWidth,
    };
  }, SECTION);

  expect(tableScrollers.overflowX).toBe("auto");
  expect(tableScrollers.scrolls).toBe(true);
});

test("an expanded reader disclosure keeps its hanging permalink reachable", async ({
  page,
}) => {
  await page.goto("/dev?visual=inspector-pane", { waitUntil: "commit" });
  for (const width of PANE_WIDTHS) {
    const section = page.locator(`${SECTION}[data-pane-width="${width}"]`);
    const disclosure = section.locator(".reader-apparatus");
    const trigger = disclosure.locator('[data-slot="collapsible-trigger"]');
    const panel = disclosure.locator('[data-slot="collapsible-panel"]');
    const paragraph = disclosure.locator('[data-anchor="p-apparatus"]');
    const permalink = paragraph.locator('a[href="#p-apparatus"]');
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitForStableGeometry(page, panel);
    await paragraph.hover();
    await expect(permalink).toHaveCSS("opacity", "1");
    const outside = await permalink.evaluate((element) => {
      const ownerPanel = element.closest('[data-slot="collapsible-panel"]');
      const linkBox = element.getBoundingClientRect();
      const panelBox = ownerPanel?.getBoundingClientRect();
      return (
        panelBox !== undefined &&
        (linkBox.right <= panelBox.left || linkBox.left >= panelBox.right)
      );
    });
    expect(outside).toBe(true);
    await expect.poll(async () => await permalinkHit(permalink)).toBe(true);
    // A normal pointer action must receive events at the control's own box.
    await permalink.click({ trial: true });
    await trigger.focus();
    await page.keyboard.press("Tab");
    await expect(permalink).toBeFocused();
    await expect.poll(async () => await permalinkHit(permalink)).toBe(true);
    await trigger.click();
    await expect(panel).toHaveAttribute("hidden", "until-found");
    await expect.poll(async () => await permalinkHit(permalink)).toBe(false);
  }
});

const permalinkHit = async (link: Locator): Promise<boolean> =>
  await link.evaluate((element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
      return false;
    }
    const target = element.ownerDocument.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return target === element || (target !== null && element.contains(target));
  });
