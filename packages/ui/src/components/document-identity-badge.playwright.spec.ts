import { expect, test } from "@playwright/test";

for (const locale of ["en", "ar"] as const) {
  test(`document identity follows available width and keeps rail chips inside their slots (${locale})`, async ({
    page,
  }) => {
    await page.goto(
      `/src/components/fixtures/document-identity.fixture.html?lang=${locale}`,
      { waitUntil: "domcontentloaded" },
    );
    const narrow = page.getByTestId("narrow");
    await expect(narrow.getByText("172/26", { exact: true })).toBeVisible();
    await expect(narrow.getByText("172/2026", { exact: true })).toBeHidden();
    for (const slot of ["room", "wide"]) {
      const row = page.getByTestId(slot);
      await expect(row.getByText("172/2026", { exact: true })).toBeVisible();
      await expect(row.getByText("172/26", { exact: true })).toBeHidden();
    }
    const tabs = page.getByTestId("rail").getByRole("button");
    await expect(tabs).toHaveCount(4);
    await expect(
      tabs.nth(0).getByText("172/26", { exact: true }),
    ).toBeVisible();
    await expect(
      tabs.nth(0).getByText("172/2026", { exact: true }),
    ).toBeHidden();
    await expect(
      tabs.nth(1).getByText("12345/01", { exact: true }),
    ).toBeVisible();
    await expect(
      tabs.nth(2).getByText("SCOTUS", { exact: true }),
    ).toBeVisible();
    await expect(tabs.nth(3).getByText("ÚS", { exact: true })).toBeVisible();
    for (const tab of await tabs.all()) {
      const bounds = await tab.evaluate((button) => {
        const slot = button.getBoundingClientRect();
        const mark = button
          .querySelector('[data-slot="document-identity-badge"]')
          ?.getBoundingClientRect();
        const text =
          button.querySelector('[data-slot="court-badge"]') ??
          [...button.querySelectorAll("bdi")].find(
            (element) => getComputedStyle(element).display !== "none",
          );
        const range = document.createRange();
        if (text !== undefined && text !== null) {
          range.selectNodeContents(text);
        }
        const glyphs = range.getBoundingClientRect();
        return {
          glyphs: { start: glyphs.left, end: glyphs.right },
          slot: { start: slot.left, end: slot.right },
          mark:
            mark === undefined ? null : { start: mark.left, end: mark.right },
        };
      });
      expect(bounds.mark).not.toBeNull();
      expect(bounds.mark?.start).toBeGreaterThanOrEqual(bounds.slot.start);
      expect(bounds.mark?.end).toBeLessThanOrEqual(bounds.slot.end);
      expect(bounds.glyphs.start).toBeGreaterThanOrEqual(bounds.slot.start);
      expect(bounds.glyphs.end).toBeLessThanOrEqual(bounds.slot.end);
    }
    await narrow.locator('[data-slot="tooltip-trigger"]').hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      locale === "ar"
        ? "172/2026 Sb., قانون السجلات العامة"
        : "172/2026 Sb., zákon o veřejných listinách",
    );
  });
}
