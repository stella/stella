import { expect, test } from "@playwright/test";

const name = `${"Shared matter prefix ".repeat(20)}distinguishing suffix`;

for (const width of [390, 768, 1024, 1440]) {
  for (const inspector of ["closed", "open"] as const) {
    test(`clipped identities disclose on focus at ${width}px with inspector ${inspector}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/src/components/fixtures/identity-text.fixture.html");
      if (inspector === "open") {
        await page
          .getByRole("complementary", { includeHidden: true })
          .evaluate((element) => element.classList.remove("hidden"));
      }
      for (const consumer of ["sidebar", "card"] as const) {
        const owner = page.getByTestId(consumer);
        const text = owner.locator('[dir="auto"]');
        await expect(text).toBeVisible();
        expect(
          await text.evaluate(
            (element) => element.scrollWidth > element.clientWidth,
          ),
        ).toBe(true);
        await expect(text).not.toHaveAttribute("tabindex", "0");
        await owner.focus();
        await expect(page.getByRole("tooltip")).toHaveText(name);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("tooltip")).toBeHidden();
      }
      const standalone = page.locator('span[tabindex="0"]');
      await expect(standalone).toHaveCount(1);
      await standalone.focus();
      await expect(page.getByRole("tooltip")).toHaveText(name);
      await expect(
        page.getByText("Short name", { exact: true }),
      ).not.toHaveAttribute("tabindex");
    });
  }
}
