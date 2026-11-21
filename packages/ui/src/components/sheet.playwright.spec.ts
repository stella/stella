import { expect, test } from "@playwright/test";

for (const direction of ["ltr", "rtl"] as const) {
  for (const width of [640, 844]) {
    test(`landscape sheets clear exposed edges at ${width}px in ${direction}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 390 });
      await page.goto("/src/components/fixtures/sheet.fixture.html");
      // Inspect settled geometry independently of the entrance animation.
      await page.addStyleTag({
        content: "[data-slot=sheet-popup] { transition: none !important; }",
      });
      // Synthetic insets exercise both notch edges even on desktop Chromium.
      await page.evaluate((dir) => {
        document.documentElement.dir = dir;
        document.documentElement.style.setProperty(
          "--safe-area-inline-start",
          "44px",
        );
        document.documentElement.style.setProperty(
          "--safe-area-inline-end",
          "28px",
        );
      }, direction);
      await page
        .getByRole("button", { name: "Full-width inspector", exact: true })
        .click();
      const inspector = page.getByRole("dialog", {
        name: "Full-width inspector",
      });
      await expect(inspector).toHaveCSS("translate", "none");
      await expect(inspector).toHaveCSS("padding-inline-start", "44px");
      await expect(inspector).toHaveCSS("padding-inline-end", "28px");
      const clearance = await page
        .getByTestId("inspector-content")
        .evaluate((element) => {
          const { left, right } = element.getBoundingClientRect();
          return { left, right: window.innerWidth - right };
        });
      expect(clearance.left).toBeGreaterThanOrEqual(
        direction === "ltr" ? 44 : 28,
      );
      expect(clearance.right).toBeGreaterThanOrEqual(
        direction === "ltr" ? 28 : 44,
      );
      const inspectorCloseClearance = await inspector
        .getByRole("button", { name: "Close", exact: true })
        .evaluate((element) => {
          const { left, right } = element.getBoundingClientRect();
          return document.documentElement.dir === "rtl"
            ? left
            : window.innerWidth - right;
        });
      expect(
        inspectorCloseClearance,
        `Full-width close button inline-end clearance (${direction}, ${width}px)`,
      ).toBeGreaterThanOrEqual(28 + 8);
      await page.keyboard.press("Escape");
      await expect(inspector).not.toBeVisible();
      await page
        .getByRole("button", { name: "Normal-width sheet", exact: true })
        .click();
      const normal = page.getByRole("dialog", { name: "Normal-width sheet" });
      await expect(normal).toHaveCSS("translate", "none");
      await expect(normal).toHaveCSS("padding-inline-start", "0px");
      await expect(normal).toHaveCSS("padding-inline-end", "28px");
      const normalCloseClearance = await normal
        .getByRole("button", { name: "Close", exact: true })
        .evaluate((element) => {
          const { left, right } = element.getBoundingClientRect();
          return document.documentElement.dir === "rtl"
            ? left
            : window.innerWidth - right;
        });
      expect(
        normalCloseClearance,
        `Normal-width close button inline-end clearance (${direction}, ${width}px)`,
      ).toBeGreaterThanOrEqual(28 + 8);
      console.info({
        direction,
        width,
        inspectorCloseClearance,
        normalCloseClearance,
      });
    });
  }
}
