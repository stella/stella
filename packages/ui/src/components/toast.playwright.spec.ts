import { expect, test } from "@playwright/test";

const fixturePath = "/src/components/fixtures/toast.fixture.html";
const reason = `Anthropic: The complete provider rejection must remain available. ${"UnbrokenProviderDiagnostic".repeat(
  20,
)}`;
const detail = `Request rejected.\n${"The complete provider response must remain available. ".repeat(
  12,
)}`;

for (const direction of ["ltr", "rtl"] as const) {
  test(`desktop toast offset clears the safe area in ${direction}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(fixturePath);
    await page.evaluate((dir) => {
      document.documentElement.dir = dir;
      document.documentElement.style.setProperty(
        "--safe-area-inline-end",
        "24px",
      );
      document.documentElement.style.setProperty(
        "--stella-toast-right-offset",
        "32px",
      );
    }, direction);
    await page.getByRole("button", { name: "success", exact: true }).click();
    const viewport = page.locator('[data-slot="toast-viewport"]');
    await expect(viewport).toHaveCSS("inset-inline-end", "88px");
    const clearance = await viewport.evaluate((element) => {
      const { left, right } = element.getBoundingClientRect();
      return document.documentElement.dir === "rtl"
        ? left
        : window.innerWidth - right;
    });
    expect(clearance).toBe(88);
  });
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
