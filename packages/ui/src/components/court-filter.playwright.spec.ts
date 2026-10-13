import { expect, test } from "@playwright/test";

for (const locale of ["en", "ar"]) {
  const tierLabel = locale === "ar" ? "المحاكم العليا" : "Supreme courts";
  test(`filtered tier selection applies the cap only to visible courts (${locale})`, async ({
    page,
  }) => {
    await page.goto(
      `/src/components/fixtures/court-filter.fixture.html?locale=${locale}`,
    );
    const tier = page.getByRole("checkbox", { name: tierLabel, exact: true });
    await expect(tier).toBeDisabled();
    await page.getByRole("searchbox").fill("NS");
    await expect(
      page.getByRole("checkbox", { name: "US", exact: true }),
    ).toHaveCount(0);
    await expect(tier).toBeEnabled();
    await tier.check();
    await expect(page.getByLabel("Selected courts")).toHaveText('["NS"]');
    await page.getByRole("searchbox").fill("");
    await expect(tier).toHaveAttribute("aria-checked", "mixed");
    await expect(
      page.getByRole("checkbox", { name: "US", exact: true }),
    ).not.toBeChecked();
  });

  test(`filtered tier toggles preserve hidden selections (${locale})`, async ({
    page,
  }) => {
    await page.goto(
      `/src/components/fixtures/court-filter.fixture.html?locale=${locale}&cap=two`,
    );
    await page.getByRole("checkbox", { name: "US", exact: true }).check();
    await page.getByRole("searchbox").fill("NS");
    const tier = page.getByRole("checkbox", { name: tierLabel, exact: true });
    await expect(tier).not.toBeChecked();
    await tier.check();
    await expect(page.getByLabel("Selected courts")).toHaveText('["US","NS"]');
    await tier.uncheck();
    await expect(page.getByLabel("Selected courts")).toHaveText('["US"]');
  });
}
