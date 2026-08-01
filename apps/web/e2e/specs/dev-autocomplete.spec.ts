import { expect, test } from "../helpers/test";

// Local E2E runs normally target Vite. Production CI opts out explicitly so
// this same spec proves the dev route cannot leak into the built app.
const EXPECTS_DEV_ROUTES = process.env["E2E_EXPECT_DEV_ROUTES"] !== "false";

test(
  "autocomplete playground matches the web runtime mode",
  {
    tag: "@dev-canary",
  },
  async ({ page }) => {
    await page.goto("/dev/autocomplete", { waitUntil: "commit" });

    if (!EXPECTS_DEV_ROUTES) {
      await expect(page).toHaveURL((url) => url.pathname === "/");
      return;
    }

    await expect(page).toHaveURL(/\/dev\/autocomplete$/u);
    await expect(
      page.getByRole("heading", {
        name: "stella autocomplete — dev playground",
      }),
    ).toBeVisible({ timeout: 30_000 });
  },
);
