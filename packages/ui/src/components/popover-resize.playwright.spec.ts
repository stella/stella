import { expect, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/popover-resize.fixture.html";

const VIEWPORT = { width: 1280, height: 800 };
// `w-[44rem]` on the editor view.
const EDITOR_WIDTH = 704;

test.use({
  viewport: VIEWPORT,
  isMobile: false,
  hasTouch: false,
  deviceScaleFactor: 1,
});

test.beforeEach(async ({ page }) => {
  await page.goto(fixturePath);
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => document.documentElement.dataset["popoverResizeReady"] ?? "",
        ),
    )
    .toBe("true");
});

test("keeps a popup that widens while open inside the viewport", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Open" }).click();

  const popup = page.locator('[data-slot="popover-popup"]');
  await expect(popup).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("editor")).toBeVisible();

  // The popup animates its width, and Base UI repositions on the resize, so
  // wait for the rendered width to settle before measuring the edges.
  await expect
    .poll(async () => Math.round((await popup.boundingBox())?.width ?? 0))
    .toBe(EDITOR_WIDTH);

  const box = await popup.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(VIEWPORT.width);
});
