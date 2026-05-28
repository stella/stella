import { expect, test } from "@playwright/test";

test("authenticated session lands inside the app shell", async ({ page }) => {
  await page.goto("/");
  // Authenticated users never see /auth/*; the protected routes either render
  // or redirect deeper. toHaveURL auto-retries so client-side redirects can't
  // race a static URL assertion.
  await expect(page).not.toHaveURL(/\/auth(\/|$)/u);
});
