import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";

test("autocomplete playground matches the web runtime mode", async ({
  page,
}) => {
  await page.goto("/dev?visual=autocomplete", { waitUntil: "commit" });

  if (!EXPECTS_DEV_RUNTIME) {
    await expect(page).toHaveURL((url) =>
      url.pathname.startsWith("/workspaces"),
    );
    await expect(page.locator("main").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.locator('[data-playground-section="fixture:autocomplete"]'),
    ).toHaveCount(0);
    return;
  }

  await expect(page).toHaveURL(/\/dev\?visual=autocomplete$/u);
  await expect(
    page.getByRole("heading", {
      name: "stella autocomplete — dev playground",
    }),
  ).toBeVisible({ timeout: 30_000 });
});
