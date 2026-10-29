/**
 * The consent card scrolls its body and keeps Decline and Allow clear of it.
 *
 * Measured on `/dev?visual=oauth-consent`, which draws the product's consent
 * card with every permission a connector can ask for. With the full
 * permission list open, at a desktop viewport shorter than the list and at a
 * phone viewport: the body scrolls, it ends where the decision bar begins,
 * a click at the centre of each decision button reaches that button, and the
 * last permission can be scrolled into view above the bar. Every project runs
 * it, so it holds right to left (`ar`) as well.
 */

import type { Page } from "@playwright/test";

import {
  expect,
  stableBoundingBox,
  test,
  waitForStableGeometry,
} from "../helpers/stable-geometry";

const CARD = '[data-slot="consent-card"]';
const BODY = `${CARD} [data-slot="scroll-area-viewport"]`;
const BAR = `${CARD} [data-slot="consent-decision-bar"]`;
const PERMISSIONS = `${CARD} [data-slot="consent-permissions"]`;

/** Sub-pixel rounding is not overlap. */
const TOLERANCE_PX = 1;

const VIEWPORTS = {
  // Shorter than the open list, wide enough for the card's floating layout.
  desktop: { width: 1280, height: 720 },
  phone: { width: 390, height: 664 },
} as const;

type CardGeometry = {
  bodyBottom: number;
  bodyClientHeight: number;
  bodyScrollHeight: number;
  barTop: number;
  barBottom: number;
  buttonsHit: boolean[];
  windowHeight: number;
};

const readGeometry = async (page: Page): Promise<CardGeometry> => {
  await waitForStableGeometry(page, page.locator(CARD));
  return await page.evaluate(
    ({ bodySelector, barSelector }) => {
      const body = document.querySelector(bodySelector);
      const bar = document.querySelector(barSelector);
      if (!(body instanceof HTMLElement) || !(bar instanceof HTMLElement)) {
        throw new Error("consent card is missing its body or decision bar");
      }
      const barBox = bar.getBoundingClientRect();
      return {
        bodyBottom: body.getBoundingClientRect().bottom,
        bodyClientHeight: body.clientHeight,
        bodyScrollHeight: body.scrollHeight,
        barTop: barBox.top,
        barBottom: barBox.bottom,
        buttonsHit: [...bar.querySelectorAll("button")].map((button) => {
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return hit !== null && button.contains(hit);
        }),
        windowHeight: window.innerHeight,
      };
    },
    { bodySelector: BODY, barSelector: BAR },
  );
};

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test.describe(name, () => {
    test.use({ viewport });

    test("with every permission open the body scrolls above Decline and Allow", async ({
      page,
    }) => {
      await page.goto("/dev?visual=oauth-consent", {
        waitUntil: "domcontentloaded",
      });
      const card = page.locator(CARD);
      await expect(card).toBeVisible();
      // The playground stacks its fixture label and client switches above the
      // card's full-height page; bring that page to the top of the viewport.
      await card.evaluate((element) => {
        element.closest("main")?.scrollIntoView({ block: "start" });
      });
      await page.locator(`${PERMISSIONS} > summary`).click();
      await expect(page.locator(PERMISSIONS)).toHaveAttribute("open", "");

      const geometry = await readGeometry(page);
      expect(
        geometry.bodyScrollHeight,
        `${name}: the open list overflows the body, so the body scrolls`,
      ).toBeGreaterThan(geometry.bodyClientHeight);
      expect(
        geometry.bodyBottom,
        `${name}: the body ends where the decision bar begins`,
      ).toBeLessThanOrEqual(geometry.barTop + TOLERANCE_PX);
      expect(
        geometry.barBottom,
        `${name}: the decision bar is inside the viewport`,
      ).toBeLessThanOrEqual(geometry.windowHeight + TOLERANCE_PX);
      expect(
        geometry.buttonsHit,
        `${name}: a click at each decision button's centre reaches it`,
      ).toEqual([true, true]);

      await page.locator(BODY).evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const lastBox = await stableBoundingBox(
        page,
        page.locator(`${PERMISSIONS} li`).last(),
      );
      const barBox = await stableBoundingBox(page, page.locator(BAR));
      expect(
        lastBox.y + lastBox.height,
        `${name}: the last permission scrolls into view above the bar`,
      ).toBeLessThanOrEqual(barBox.y + TOLERANCE_PX);
    });
  });
}
