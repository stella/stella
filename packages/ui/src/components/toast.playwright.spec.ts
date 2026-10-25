import { expect, test } from "@playwright/test";

import type { ToastPosition } from "./toast";

const fixturePath = "/src/components/fixtures/toast.fixture.html";
const reason = `Anthropic: The complete provider rejection must remain available. ${"UnbrokenProviderDiagnostic".repeat(
  20,
)}`;
const detail = `Request rejected.\n${"The complete provider response must remain available. ".repeat(
  12,
)}`;

const insetCases = [
  { name: "no insets", start: 0, end: 0 },
  { name: "start only", start: 44, end: 0 },
  { name: "end only", start: 0, end: 44 },
  { name: "both insets", start: 44, end: 44 },
];
const positions = {
  "top-left": true,
  "top-center": true,
  "top-right": true,
  "bottom-left": true,
  "bottom-center": true,
  "bottom-right": true,
} as const satisfies Record<ToastPosition, true>;

for (const direction of ["ltr", "rtl"] as const) {
  for (const position of Object.keys(positions)) {
    for (const { name, start, end } of insetCases) {
      for (const offset of [0, 400]) {
        test(`toast geometry ${direction} ${position}, ${name}, offset ${offset}`, async ({
          page,
        }) => {
          // Exercise both the inspector breakpoint and a viewport that forces
          // even an unshifted toast to shrink inside the safe-area gutters.
          for (const width of [844, 320]) {
            await page.setViewportSize({ width, height: 390 });
            await page.goto(`${fixturePath}?position=${position}`);
            await page.evaluate(
              (geometry) => {
                document.documentElement.dir = geometry.direction;
                for (const [property, value] of Object.entries({
                  "--safe-area-inline-start": geometry.start,
                  "--safe-area-inline-end": geometry.end,
                  "--stella-toast-right-offset": geometry.offset,
                })) {
                  document.documentElement.style.setProperty(
                    property,
                    `${value}px`,
                  );
                }
              },
              { direction, start, end, offset },
            );
            await page
              .getByRole("button", { name: "success", exact: true })
              .click();
            const viewport = page.locator('[data-slot="toast-viewport"]');
            await expect(
              page.locator('[data-slot="toast-title"]'),
            ).toBeVisible();
            const bounds = await viewport.evaluate((element) => {
              const {
                left,
                right,
                width: toastWidth,
              } = element.getBoundingClientRect();
              return { left, right, width: toastWidth };
            });
            const gutter = width >= 640 ? 32 : 16;
            const available = width - start - end - 2 * gutter;
            const shift =
              position.endsWith("right") && width >= 768
                ? Math.min(offset, Math.max(0, available - 160))
                : 0;
            const expectedWidth = Math.min(360, available - shift);
            const inlineStart =
              direction === "ltr" ? bounds.left : width - bounds.right;
            const inlineEnd =
              direction === "ltr" ? width - bounds.right : bounds.left;
            expect(bounds.width).toBeCloseTo(expectedWidth);
            expect(inlineStart).toBeGreaterThanOrEqual(start + gutter - 0.01);
            expect(inlineEnd).toBeGreaterThanOrEqual(
              end + gutter + shift - 0.01,
            );
            if (position.endsWith("center")) {
              expect(inlineStart - start).toBeCloseTo(inlineEnd - end);
            }
          }
        });
      }
    }
    test(`toast inspector clamp ${direction} ${position}`, async ({ page }) => {
      await page.setViewportSize({ width: 844, height: 390 });
      await page.goto(`${fixturePath}?position=${position}`);
      await page.evaluate((dir) => {
        document.documentElement.dir = dir;
        document.documentElement.style.setProperty(
          "--safe-area-inline-start",
          "44px",
        );
        document.documentElement.style.setProperty(
          "--safe-area-inline-end",
          "44px",
        );
        document.documentElement.style.setProperty(
          "--stella-toast-right-offset",
          "1000px",
        );
      }, direction);
      await page.getByRole("button", { name: "success", exact: true }).click();
      const viewport = page.locator('[data-slot="toast-viewport"]');
      await expect(viewport).toHaveCSS(
        "width",
        position.endsWith("right") ? "160px" : "360px",
      );
      const clearance = await viewport.evaluate((element) => {
        const { left, right } = element.getBoundingClientRect();
        return document.documentElement.dir === "rtl"
          ? window.innerWidth - right
          : left;
      });
      expect(clearance).toBeGreaterThanOrEqual(76);
    });
  }
}

for (const entry of ["error", "add", "update", "promise"]) {
  test(`error toast via ${entry} keeps full wrapping text until dismissed`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto(fixturePath);
    await page.getByRole("button", { name: entry, exact: true }).click();
    // Move the pointer away: hovering the toast would pause even a timed toast.
    await page.mouse.move(0, 0);
    const title = page.locator('[data-slot="toast-title"]');
    const description = page.locator('[data-slot="toast-description"]');
    await expect(title).toHaveText(reason);
    await expect(description).toHaveText(detail);
    if (entry === "promise") {
      await expect(page.locator("html")).toHaveAttribute(
        "data-promise-rejection",
        reason,
      );
    }
    for (const surface of [title, description]) {
      await expect(surface).toHaveCSS("white-space", "pre-wrap");
      await expect(surface).toHaveCSS("overflow-wrap", "anywhere");
      await expect(surface).toHaveCSS("text-overflow", "clip");
    }
    // The former error timeout was 6000 ms. Persistence must survive it without
    // hiding the provider's reason before the user can inspect or copy it.
    await page.clock.fastForward(10_000);
    await expect(title).toBeVisible();
    // Base UI exposes toast controls when the notification is expanded.
    await title.hover();
    await page.getByRole("button", { name: "Close notification" }).click();
    await page.clock.fastForward(1000);
    await expect(title).toHaveCount(0);
  });
}

test("a plain error toast counts down and closes on its own", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto(fixturePath);
  await page.getByRole("button", { name: "plain error", exact: true }).click();
  await page.mouse.move(0, 0);
  const title = page.locator('[data-slot="toast-title"]');
  await expect(title).toHaveText("Plain failure");
  await expect(page.locator('[data-slot="toast-countdown"]')).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(title).toHaveCount(0);
});

test("success toasts retain their automatic timeout", async ({ page }) => {
  await page.clock.install();
  await page.goto(fixturePath);
  await page.getByRole("button", { name: "success", exact: true }).click();
  await page.mouse.move(0, 0);
  const title = page.locator('[data-slot="toast-title"]');
  await expect(title).toHaveText("Successful request");
  await page.clock.fastForward(10_000);
  await expect(title).toHaveCount(0);
});
