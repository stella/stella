import { expect, test } from "@playwright/test";

import { appShellNavigationLink } from "../helpers/app-shell";

test.use({ storageState: { cookies: [], origins: [] } });

test("app shell readiness is owned by sidebar navigation", async ({ page }) => {
  await page.setContent(`
    <aside data-slot="sidebar"><a href="/chat">Chat</a></aside>
    <nav aria-label="Breadcrumb"><a href="/chat">Chat</a></nav>
  `);

  const chatNavigation = appShellNavigationLink(page, "/chat");
  await expect(chatNavigation).toHaveCount(1);
  await expect(chatNavigation).toBeVisible();
});
