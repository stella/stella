/**
 * The inspector's phone header holds still when the inspector loads.
 *
 * On a phone the sheet shows its pending header while the inspector's code
 * loads, then the loaded tab header replaces it in place. Back, the tab
 * switcher and Close are where the reader's thumb already is, so none of them
 * may move between the two phases. That is layout, so it is measured, on the
 * bench at `/dev?visual=inspector-phone-header`, which draws both phases at
 * the widths the sheet takes on a 390px and a 360px phone. Every project runs
 * it, so it holds right to left (`ar`) as well.
 */

import type { Page } from "@playwright/test";

import {
  expect,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

/** Mirrors the bench's sheet widths; the spec stays out of the app graph. */
const SHEET_WIDTHS = [341, 311] as const;

const PHASES = ["pending", "loaded"] as const;

type Box = { left: number; top: number; width: number; height: number };

type HeaderGeometry = {
  header: Box;
  back: Box;
  switcher: Box;
  close: Box;
};

// Below `md` the rail is hidden and the header carries Back and the switcher.
test.use({ viewport: { width: 390, height: 844 } });

const readGeometry = async (
  page: Page,
  section: string,
): Promise<HeaderGeometry> => {
  const locator = page.locator(`[data-playground-section="${section}"]`);
  await waitForStableGeometry(page, locator);
  return await locator.evaluate((element) => {
    const origin = element.getBoundingClientRect();
    const box = (selector: string): Box => {
      const part = element.querySelector(selector);
      if (!(part instanceof HTMLElement)) {
        throw new TypeError(`phone header bench is missing ${selector}`);
      }
      const rect = part.getBoundingClientRect();
      return {
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      header: box('[data-slot="inspector-panel-header"]'),
      back: box('[data-slot="inspector-phone-navigation"] > button'),
      switcher: box('[data-slot="inspector-tab-switcher"]'),
      close: box(
        '[data-slot="inspector-panel-header"] > div:last-child > button:last-of-type',
      ),
    };
  });
};

test("Back, the tab switcher and Close do not move when the header loads", async ({
  page,
}) => {
  await page.goto("/dev?visual=inspector-phone-header", {
    waitUntil: "commit",
  });
  // The bench is ready when every header has drawn, not on the load event.
  await expect(
    page.locator('[data-playground-section^="inspector-phone-header:"]'),
  ).toHaveCount(SHEET_WIDTHS.length * PHASES.length);
  await expect(
    page.locator('[data-slot="inspector-tab-switcher"]'),
  ).toHaveCount(SHEET_WIDTHS.length * PHASES.length);
  for (const width of SHEET_WIDTHS) {
    const [pending, loaded] = await Promise.all(
      PHASES.map(
        async (phase) =>
          await readGeometry(page, `inspector-phone-header:${phase}:${width}`),
      ),
    );
    // A vacuous pass would measure controls the phone does not show.
    expect(pending?.switcher.width, `switcher shown at ${width}px`).toBe(32);
    expect(loaded, `header at ${width}px`).toEqual(pending);
  }
});
