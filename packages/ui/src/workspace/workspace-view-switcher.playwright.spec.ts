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
  const tabs = page.locator('[data-slot="tabs-tab"]');
  const toolbar = page.locator("[data-workspace-switcher] > [dir]");
  const indicator = page.locator('[data-slot="tab-indicator"]');

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
    test(`keeps the add action fixed beside overflowing ${direction.toUpperCase()} tabs`, async ({
      page,
    }) => {
      await openFixture(page, { direction, overflow: true });
      const tabList = page.getByRole("tablist");
      const addView = page.getByRole("button", {
        name: direction === "rtl" ? "إضافة عرض" : "Add view",
      });
      const actionArea = addView.locator("..");

      const overflow = await tabList.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(overflow).toBeGreaterThan(0);
      await expect(addView).toBeVisible();
      await expect
        .poll(
          async () =>
            await actionArea.evaluate(
              (element) => getComputedStyle(element).borderInlineStartWidth,
            ),
        )
        .toBe("1px");

      const before = await addView.boundingBox();
      const scrolled = await tabList.evaluate((element, isRTL) => {
        element.scrollLeft = isRTL ? -element.scrollWidth : element.scrollWidth;
        return element.scrollLeft;
      }, direction === "rtl");
      // The add action sits outside the scroll container, so its position
      // would hold even if the assignment never moved the strip. Chromium
      // counts RTL offsets down from zero, so the far end is -overflow there
      // and +overflow in LTR; scrollWidth and clientWidth round to integers
      // while scrollLeft does not, hence the tolerance.
      const scrollEnd = direction === "rtl" ? -overflow : overflow;
      expect(Math.abs(scrolled - scrollEnd)).toBeLessThanOrEqual(TOLERANCE_PX);

      const after = await addView.boundingBox();

      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(after?.x).toBeCloseTo(before?.x ?? 0, 0);
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
              throw new Error("Expected an HTML scroll container");
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
