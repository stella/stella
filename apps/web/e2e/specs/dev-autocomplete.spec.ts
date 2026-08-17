import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";

test("autocomplete playground matches the web runtime mode", async ({
  page,
}) => {
  await page.goto("/dev/autocomplete", { waitUntil: "commit" });

  if (!EXPECTS_DEV_RUNTIME) {
    await expect(page).toHaveURL((url) => url.pathname === "/");
    return;
  }

  await expect(page).toHaveURL(/\/dev\/autocomplete$/u);
  await expect(
    page.getByRole("heading", {
      name: "stella autocomplete — dev playground",
    }),
  ).toBeVisible({ timeout: 30_000 });
});
