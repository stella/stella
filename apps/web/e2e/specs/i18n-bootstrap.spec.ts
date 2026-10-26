import { expect, test } from "@playwright/test";

import { PRESENTATION_PREFS_COOKIE } from "../../src/lib/account/presentation-prefs/preferences";

test.use({ storageState: { cookies: [], origins: [] } });

test("malformed presentation cookie cannot block app bootstrap", async ({
  baseURL,
  page,
}) => {
  const webBaseURL = baseURL ?? "http://localhost:3000";
  await page.context().addCookies([
    {
      name: PRESENTATION_PREFS_COOKIE,
      value: encodeURIComponent("{"),
      url: new URL("/", webBaseURL).href,
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(webBaseURL).protocol === "https:",
    },
  ]);

  await page.goto("/", { waitUntil: "commit" });

  await expect(page).toHaveURL(/\/auth\/?$/u, { timeout: 30_000 });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
