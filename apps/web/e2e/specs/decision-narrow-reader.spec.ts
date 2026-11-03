import type { Locator, Page } from "@playwright/test";

import {
  DECISION_READER_BOOT_PATH,
  openVisitorDecision,
} from "../helpers/decision-reader";
import {
  DOCKED_CHAT_LEGAL_ROUTES,
  installDockedLegalFixtures,
} from "../helpers/docked-chat-legal-fixtures";
import { expect, test } from "../helpers/test";

// A decision opened from an assistant's link lands in that assistant's
// built-in browser pane: a phone-width column, usually signed out.
const NARROW_VIEWPORTS = [
  { width: 400, height: 860 },
  { width: 580, height: 900 },
] as const;

const openDecision = async (page: Page) => {
  await installDockedLegalFixtures(page);
  await openVisitorDecision(page, {
    bootPath: DECISION_READER_BOOT_PATH,
    path: DOCKED_CHAT_LEGAL_ROUTES.decision.path,
  });
  await expect(page.locator(".reader-scroll article")).toBeVisible();
};

/** The element painted at a locator's centre, as the pointer would hit it. */
const topmostAtCentreIsInside = async (
  target: Locator,
  container: Locator,
): Promise<boolean> => {
  const box = await target.boundingBox();
  if (box === null) {
    return false;
  }
  const handle = await container.elementHandle();
  return target
    .page()
    .evaluate(
      ({ x, y, element }) => element.contains(document.elementFromPoint(x, y)),
      { x: box.x + box.width / 2, y: box.y + box.height / 2, element: handle },
    );
};

const readerTextScale = async (page: Page) =>
  page
    .locator('[data-slot="reader-text-root"]')
    .first()
    .evaluate((element) =>
      Number(getComputedStyle(element).getPropertyValue("--reader-text-scale")),
    );

for (const viewport of NARROW_VIEWPORTS) {
  test.describe(`narrow decision reader at ${String(viewport.width)}px`, () => {
    test.use({
      storageState: { cookies: [], origins: [] },
      locale: "en-US",
      viewport,
    });

    test("a visitor gets a sign-in offer where the composer would float", async ({
      page,
    }) => {
      await openDecision(page);

      const offer = page.locator('[data-slot="gated-chat-sign-in"]');
      await expect(offer).toBeVisible();
      await expect(offer).toContainText("Sign in to chat about");
      // No bar that looks typeable but cannot send.
      await expect(
        page.locator('[data-slot="docked-chat-composer"] [contenteditable]'),
      ).toHaveCount(0);

      await offer.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    });

    test("the open sidebar covers the docked offer and keeps sign-in reachable", async ({
      page,
    }) => {
      await openDecision(page);
      const offer = page.locator('[data-slot="gated-chat-sign-in"]');
      await expect(offer).toBeVisible();

      await page
        .locator("header")
        .getByRole("button", { name: "Toggle sidebar" })
        .click();
      // The mobile sidebar is a sheet that names its own slot.
      const sheet = page.locator('[data-slot="sidebar"][data-mobile="true"]');
      await expect(sheet).toBeVisible();

      const signIn = sheet.getByRole("button", { name: "Sign in" });
      await expect(signIn).toBeVisible();
      expect(await topmostAtCentreIsInside(signIn, signIn)).toBe(true);
      // The sheet is modal: whatever sits where the offer floats belongs to
      // the sheet or its backdrop, never to the offer.
      expect(await topmostAtCentreIsInside(offer, offer)).toBe(false);
    });

    test("the reader steps its text size and keeps it on this device", async ({
      page,
    }) => {
      await openDecision(page);
      expect(await readerTextScale(page)).toBe(1);

      await page.getByRole("button", { name: "Zoom in" }).click();
      await expect.poll(async () => readerTextScale(page)).toBeGreaterThan(1);
      const enlarged = await readerTextScale(page);

      await openDecision(page);
      await expect.poll(async () => readerTextScale(page)).toBe(enlarged);

      await page.getByRole("button", { name: "Zoom out" }).click();
      await expect
        .poll(async () => readerTextScale(page))
        .toBeLessThan(enlarged);
    });

    test("header crumbs never paint over each other", async ({ page }) => {
      await openDecision(page);
      const header = page.locator("header").first();
      // The trail above the document gives way at this width; only the
      // crumbs still drawn can collide.
      const crumbs = header
        .locator(
          '[data-slot="breadcrumb-item"], [data-slot="breadcrumb-separator"]',
        )
        .filter({ visible: true });
      await expect(crumbs.first()).toBeVisible();

      const boxes = await crumbs.evaluateAll((elements) =>
        elements
          .map((element) => element.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => ({ left: rect.left, right: rect.right })),
      );
      expect(boxes.length).toBeGreaterThan(0);
      for (let index = 1; index < boxes.length; index += 1) {
        const previous = boxes[index - 1];
        const current = boxes[index];
        if (previous === undefined || current === undefined) {
          continue;
        }
        expect(current.left).toBeGreaterThanOrEqual(previous.right - 0.5);
      }

      // Each crumb's own text stays inside its own box.
      const overflowing = await header
        .locator('[data-slot="breadcrumb-item"] a, [aria-current="page"]')
        .evaluateAll(
          (elements) =>
            elements.filter((element) => {
              const style = getComputedStyle(element);
              return (
                element.getClientRects().length > 0 &&
                style.overflow === "visible" &&
                element.scrollWidth > element.clientWidth + 1
              );
            }).length,
        );
      expect(overflowing).toBe(0);
    });

    test("a visitor is told the AI notes open with an account", async ({
      page,
    }) => {
      await openDecision(page);
      const offer = page.locator(
        '[data-slot="gated-analysis-invitation-narrow"]',
      );
      await expect(offer).toBeVisible();
      await offer.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    });
  });
}
