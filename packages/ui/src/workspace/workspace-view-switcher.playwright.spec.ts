import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const fixturePath = "/src/workspace/fixtures/view-switcher.fixture.html";
const TOLERANCE_PX = 1;

test.use({
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

const openFixture = async (
  page: Page,
  options: {
    direction: "ltr" | "rtl";
    dark?: boolean;
    overflow?: boolean;
  },
) => {
  const params = new URLSearchParams();
  if (options.direction === "rtl") {
    params.set("rtl", "");
  }
  if (options.dark) {
    params.set("dark", "");
  }
  if (options.overflow) {
    params.set("overflow", "");
  }

  await page.goto(`${fixturePath}?${params.toString()}`);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            document.documentElement.dataset["workspaceViewSwitcherReady"] ??
            "",
        ),
    )
    .toBe("true");
};

const expectIndicatorToTrackTab = async (page: Page, tabIndex: number) => {
  // The visible strip only: the switcher also draws an inert, hidden copy of
  // its tabs to measure them by.
  const tabList = page.getByRole("tablist");
  const tabs = tabList.locator('[data-slot="tabs-tab"]');
  const toolbar = page.locator("[data-workspace-switcher] > [dir]");
  const indicator = tabList.locator('[data-slot="tab-indicator"]');

  await expect
    .poll(async () => {
      const [tabBox, toolbarBox, indicatorBox] = await Promise.all([
        tabs.nth(tabIndex).boundingBox(),
        toolbar.boundingBox(),
        indicator.boundingBox(),
      ]);

      if (tabBox === null || toolbarBox === null || indicatorBox === null) {
        return false;
      }

      return (
        Math.abs(indicatorBox.x - tabBox.x) <= TOLERANCE_PX &&
        Math.abs(indicatorBox.width - tabBox.width) <= TOLERANCE_PX &&
        Math.abs(
          indicatorBox.y +
            indicatorBox.height -
            (toolbarBox.y + toolbarBox.height),
        ) <= TOLERANCE_PX
      );
    })
    .toBe(true);
};

test.describe("workspace view switcher chrome", () => {
  test("keeps the underline aligned after selecting tabs with conditional actions", async ({
    page,
  }) => {
    await openFixture(page, { direction: "ltr" });

    await expectIndicatorToTrackTab(page, 0);
    await page.getByRole("tab", { name: "Deadlines" }).click();
    await expectIndicatorToTrackTab(page, 1);
    await page.getByRole("tab", { name: "All matters" }).click();
    await expectIndicatorToTrackTab(page, 0);
  });

  test("keeps the underline aligned in an RTL Arabic strip", async ({
    page,
  }) => {
    await openFixture(page, { direction: "rtl" });

    await expectIndicatorToTrackTab(page, 0);
    await page.getByRole("tab", { name: "المواعيد النهائية" }).click();
    await expectIndicatorToTrackTab(page, 1);
  });

  for (const direction of ["ltr", "rtl"] as const) {
    test(`moves ${direction.toUpperCase()} tabs with no room into the overflow menu`, async ({
      page,
    }) => {
      await openFixture(page, { direction, overflow: true });
      const isRTL = direction === "rtl";
      const strip = page.locator("[data-workspace-switcher]");
      const tabList = page.getByRole("tablist");
      const tabs = page.getByRole("tab");
      const addView = page.getByRole("button", {
        name: isRTL ? "إضافة عرض" : "Add view",
      });
      const more = page.getByRole("button", {
        name: isRTL ? "عرض المزيد" : "Show more",
      });

      await expect(more).toBeVisible();
      await expect(addView).toBeVisible();
      const shownCount = await tabs.count();
      expect(shownCount).toBeGreaterThan(0);
      expect(shownCount).toBeLessThan(4);

      // Nothing hides behind a scroll: the strip holds exactly the tabs it
      // shows, and they, the menu and the add action stay inside the strip.
      expect(
        await tabList.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(TOLERANCE_PX);
      const stripBox = await strip.boundingBox();
      for (const control of [more, addView, tabs.last()]) {
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(stripBox).not.toBeNull();
        expect(box?.x ?? 0).toBeGreaterThanOrEqual(
          (stripBox?.x ?? 0) - TOLERANCE_PX,
        );
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
          (stripBox?.x ?? 0) + (stripBox?.width ?? 0) + TOLERANCE_PX,
        );
      }
      // The add action no longer sits after a scrolling strip, so it draws
      // no divider of its own.
      expect(
        await addView
          .locator("..")
          .evaluate(
            (element) => getComputedStyle(element).borderInlineStartWidth,
          ),
      ).toBe("0px");

      // Every view is a tab or a menu item, once.
      await more.click();
      const items = page.getByRole("menuitem");
      await expect(items.first()).toBeVisible();
      expect((await items.count()) + shownCount).toBe(4);
      const lastName = isRTL ? "المراسلات" : "Correspondence";
      await page.getByRole("menuitem", { name: lastName }).click();

      // The chosen view becomes the active tab and stays on screen.
      const active = page.getByRole("tab", { name: lastName });
      await expect(active).toBeVisible();
      await expect(active).toHaveAttribute("aria-selected", "true");
      expect(
        await tabList.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    });
  }
});

for (const theme of ["light", "dark"]) {
  test(`keeps the rail scrollbar hidden and content scrollbar thin in ${theme} mode`, async ({
    page,
  }) => {
    await openFixture(page, { direction: "ltr", dark: theme === "dark" });
    const scrollbars = page.locator(
      '[data-slot="inspector-rail-content"], [data-slot="inspector-content"]',
    );
    await expect
      .poll(async () =>
        scrollbars.evaluateAll((elements) =>
          elements.map((element) => {
            if (!(element instanceof HTMLElement)) {
              throw new TypeError("Expected an HTML scroll container");
            }
            const style = getComputedStyle(element);
            const track = getComputedStyle(
              element,
              "::-webkit-scrollbar-track",
            );
            return {
              slot: element.dataset["slot"],
              overflowing: element.scrollHeight > element.clientHeight,
              track: track.backgroundColor,
              width: style.scrollbarWidth,
            };
          }),
        ),
      )
      .toEqual([
        {
          slot: "inspector-rail-content",
          overflowing: true,
          track: "rgba(0, 0, 0, 0)",
          width: "none",
        },
        {
          slot: "inspector-content",
          overflowing: true,
          track: "rgba(0, 0, 0, 0)",
          width: "thin",
        },
      ]);
  });
}
