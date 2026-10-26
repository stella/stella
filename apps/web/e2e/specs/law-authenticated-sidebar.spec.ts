import { setFixedBrowserTime } from "@stll/ui/browser-clock";

import {
  SIDEBAR_STATE_COOKIE,
  SIDEBAR_STATE_VALUES,
} from "../../src/components/sidebar/sidebar-state-cookie";
import { openGlobalSearchDatePicker } from "../helpers/global-search";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

const MACOS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

for (const persistence of ["browser-default", "without-cookie-store"]) {
  test(`sidebar toggles survive reload: ${persistence}`, async ({ page }) => {
    const context = page.context();
    await context.clearCookies({ name: SIDEBAR_STATE_COOKIE });
    if (persistence === "without-cookie-store") {
      await page.addInitScript(() => {
        Reflect.deleteProperty(globalThis, "cookieStore");
      });
    }
    const scripts = Promise.withResolvers<undefined>();
    // Keep parser-blocking prepaint scripts available; delay the app modules.
    await page.route("**/assets/*.js", async (route) => {
      await scripts.promise;
      await route.fallback();
    });
    await page.goto("/law", { waitUntil: "commit" });
    const sidebar = page.locator('[data-slot="sidebar"]');
    const toggle = sidebar
      .locator('[data-slot="sidebar-header"]')
      .getByRole("button");
    try {
      await expect(sidebar).toHaveAttribute("data-state", "expanded");
      // Server-rendered controls stay unavailable until their handlers mount.
      await expect(toggle).toBeDisabled();
      if (persistence === "without-cookie-store") {
        expect(await page.evaluate(() => "cookieStore" in globalThis)).toBe(
          false,
        );
      }
    } finally {
      scripts.resolve(undefined);
    }
    for (const state of [
      SIDEBAR_STATE_VALUES.collapsed,
      SIDEBAR_STATE_VALUES.expanded,
    ]) {
      await toggle.click();
      await expect(sidebar).toHaveAttribute("data-state", state);
      await expect
        .poll(
          async () =>
            (await context.cookies()).find(
              ({ name }) => name === SIDEBAR_STATE_COOKIE,
            )?.value,
        )
        .toBe(state);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("html")).toHaveAttribute(
        "data-sidebar-state",
        state,
      );
      await expect(sidebar).toHaveAttribute("data-state", state);
    }
  });
}

test("authenticated law pages retain the user's recent matters", async ({
  page,
  request,
}) => {
  const label = "law-sidebar";
  const workspace = await createTestWorkspace(request, label);
  const workspaceName = `${label}-${workspace.id.slice(0, 8)}`;

  try {
    // /law is the law entry; it scopes itself to a jurisdiction on arrival.
    await page.goto("/law", { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/law(?:[/?#]|$)/u);
    await expect(
      page
        .locator('[data-slot="sidebar"]')
        .getByText(workspaceName, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await deleteTestWorkspace(request, workspace.id);
  }
});

test.describe("public law hydration", () => {
  test.use({
    locale: "pt-PT",
    timezoneId: "America/Los_Angeles",
    userAgent: MACOS_USER_AGENT,
  });

  test("persisted locale activates without hydration errors", async ({
    page,
  }) => {
    const fixedBrowserDate = new Date();
    fixedBrowserDate.setUTCHours(2, 0, 0, 0);
    const expectedToday = new Date(fixedBrowserDate.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await setFixedBrowserTime(page, fixedBrowserDate);
    await page.addInitScript({
      content: `window.localStorage.setItem(
        "stella-i18n",
        JSON.stringify({ state: { lang: "cs" }, version: 0 }),
      );`,
    });

    await page.goto("/law?country=cze", { waitUntil: "commit" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "cs");
    await openGlobalSearchDatePicker(page);

    await expect(
      page.locator('[role="gridcell"][aria-current="date"]'),
    ).toHaveAttribute("data-date", expectedToday);
  });
});
