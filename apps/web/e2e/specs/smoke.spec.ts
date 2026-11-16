import { appShellNavigationLink } from "../helpers/app-shell";
import { expect, test } from "../helpers/test";
import { PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS } from "../helpers/wait-budgets";

test("authenticated session lands inside the app shell", async ({ page }) => {
  await page.goto("/", { waitUntil: "commit" });
  await expect(appShellNavigationLink(page, "/chat")).toBeVisible({
    timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
  });
  // Authenticated users never see /auth/*; the protected routes either render
  // or redirect deeper. toHaveURL auto-retries so client-side redirects can't
  // race a static URL assertion.
  await expect(page).not.toHaveURL(/\/auth(?:\/|$)/u);
});
