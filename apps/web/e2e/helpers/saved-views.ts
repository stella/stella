import type { Locator, Page } from "@playwright/test";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { expect } from "./test";

/*
 * A matter's saved views, as a reader reaches them: a tab when the strip has
 * room for it, otherwise an item in the "Show more" menu after the tabs. The
 * active view is always a tab. Specs go through these helpers instead of
 * looking for a view's tab, which is not there when the view is in the menu.
 */

const viewStrip = (page: Page) =>
  page.locator('[data-slot="workspace-view-switcher"]');

/** A view's tab in the visible strip (the measuring copy is hidden). */
export const savedViewTab = (page: Page, name: string): Locator =>
  viewStrip(page).getByRole("tab", { exact: true, name });

const moreViews = (page: Page) =>
  viewStrip(page).getByRole("button", {
    exact: true,
    name: messages.common.showMore,
  });

/** A wait's own timeout when the caller gave one, else the default's. */
const within = (timeout: number | undefined) =>
  timeout === undefined ? {} : { timeout };

/** Waits until the strip has decided which views fit beside each other. */
const settledStrip = async (page: Page, timeout?: number) => {
  await expect(
    viewStrip(page).locator(
      '[data-slot="workspace-view-measure"][data-measured]',
    ),
  ).toHaveCount(1, within(timeout));
};

/** Every view the strip offers, tabs first, then the menu's, in order. */
export const savedViewNames = async (
  page: Page,
  options: { timeout?: number } = {},
): Promise<string[]> => {
  await settledStrip(page, options.timeout);
  const tabs = await viewStrip(page).getByRole("tab").allTextContents();
  if ((await moreViews(page).count()) === 0) {
    return tabs;
  }
  await moreViews(page).click();
  const items = page.getByRole("menuitem");
  await expect(items.first()).toBeVisible();
  const listed = await items.allTextContents();
  await page.keyboard.press("Escape");
  await expect(items).toHaveCount(0);
  return [...tabs, ...listed];
};

/** Waits until the strip offers a view, as a tab or in its menu. */
export const expectSavedView = async (
  page: Page,
  name: string,
  options: { timeout?: number } = {},
) => {
  await expect
    .poll(async () => await savedViewNames(page, options), {
      message: `the view strip offers "${name}"`,
      ...within(options.timeout),
    })
    .toContain(name);
};

/**
 * Switches to a view from its tab, or from the menu when the strip has no
 * room for its tab, and returns the tab it then has as the active view.
 * At the narrowest width the strip shows no tab at all, the active view's
 * included; the menu then marks the open view as current instead.
 */
export const openSavedView = async (
  page: Page,
  name: string,
  options: { timeout?: number } = {},
): Promise<Locator> => {
  await settledStrip(page, options.timeout);
  const tab = savedViewTab(page, name);
  if ((await tab.count()) > 0) {
    await tab.click();
  } else {
    await moreViews(page).click();
    await page.getByRole("menuitem", { exact: true, name }).click();
  }
  const selectedTab = viewStrip(page).getByRole("tab", {
    exact: true,
    name,
    selected: true,
  });
  const anyTab = viewStrip(page).getByRole("tab");
  const measuredCopy = viewStrip(page).locator(
    '[data-slot="workspace-view-measure"][data-measured]',
  );
  // While the view switches, its strip may not be drawn yet; only a measured
  // strip with no tab and a menu is the narrowest layout.
  const onlyTheMenu = async () =>
    (await measuredCopy.count()) === 1 &&
    (await anyTab.count()) === 0 &&
    (await moreViews(page).count()) === 1;
  // `count()` never runs the page's locator handlers, so a modal a test
  // dismisses through one (such as the AI key dialog on a deployment without
  // a provider) would hide the strip's roles for the whole poll. The
  // auto-waiting assertion first runs them on every attempt.
  await expect
    .poll(
      async () => {
        await expect(viewStrip(page)).toBeVisible();
        return (await selectedTab.count()) > 0 || (await onlyTheMenu());
      },
      {
        message: `"${name}" is the open view`,
        ...within(options.timeout),
      },
    )
    .toBe(true);
  if ((await selectedTab.count()) === 0) {
    await moreViews(page).click();
    await expect(
      page.getByRole("menuitem", { exact: true, name }),
    ).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
  }
  return tab;
};
