import { expect, test } from "@playwright/test";

test("authenticated session lands inside the app shell", async ({ page }) => {
  await page.goto("/");
  // Authenticated users never see /auth/*; the protected routes either render
  // or redirect deeper. We allow any non-/auth final URL.
  await page.waitForLoadState("domcontentloaded");
  expect(new URL(page.url()).pathname).not.toMatch(/^\/auth(\/|$)/u);
});
