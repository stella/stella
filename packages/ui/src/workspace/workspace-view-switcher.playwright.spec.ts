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
  options: { direction: "ltr" | "rtl"; dark?: boolean },
) => {
  const params = new URLSearchParams();
  if (options.direction === "rtl") {
    params.set("rtl", "");
  }
  if (options.dark) {
    params.set("dark", "");
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
});

test("uses thin scrollbars with transparent tracks for inspector content", async ({
  page,
}) => {
  for (const dark of [false, true]) {
    await openFixture(page, { direction: "ltr", dark });

    for (const slot of ["inspector-rail-content", "inspector-content"]) {
      const scrollbar = page.locator(`[data-slot="${slot}"]`);
      await expect
        .poll(
          async () =>
            await scrollbar.evaluate((element) => {
              const style = getComputedStyle(element);
              const track = getComputedStyle(
                element,
                "::-webkit-scrollbar-track",
              );
              return {
                overflowing: element.scrollHeight > element.clientHeight,
                track: track.backgroundColor,
                width: style.scrollbarWidth,
              };
            }),
        )
        .toEqual({
          overflowing: true,
          track: "rgba(0, 0, 0, 0)",
          width: "thin",
        });
    }
  }
});
