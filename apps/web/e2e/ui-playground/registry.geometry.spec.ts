import { expect, test } from "@playwright/test";

import { visualRegistry } from "../../src/routes/dev/-visual-metadata";

for (const [name, { label }] of Object.entries(visualRegistry)) {
  test(`renders the registered ${name} fixture with its label`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/dev?visual=${name}`, { waitUntil: "domcontentloaded" });

    const section = page.locator(`[data-playground-section="fixture:${name}"]`);
    await expect(section).toBeVisible();
    await expect(section.locator("header").first()).toHaveText(
      `Fixture: ${label}`,
    );
    // The label renders before the lazy component; require its actual content
    // too so a broken loader cannot satisfy the registry census.
    await expect(
      section.locator(":scope > :not(header)").first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
