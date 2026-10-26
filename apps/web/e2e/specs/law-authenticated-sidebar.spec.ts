import { setFixedBrowserTime } from "@stll/ui/browser-clock";

import { SIDEBAR_STATE_COOKIE } from "../../src/components/sidebar/sidebar-state-cookie";
import {
  parsePresentationPrefs,
  PRESENTATION_PREFS_COOKIE,
} from "../../src/lib/account/presentation-prefs/preferences";
import { E2E_API_ORIGIN } from "../helpers/api";
import { openGlobalSearchDatePicker } from "../helpers/global-search";
import { createProfileTestSession } from "../helpers/profile-session";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

const MACOS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

for (const persistence of ["browser-default", "without-cookie-store"]) {
  test(`sidebar toggles survive reload: ${persistence}`, async ({ page }) => {
    const context = page.context();
    await context.clearCookies({ name: SIDEBAR_STATE_COOKIE });
    await context.clearCookies({ name: PRESENTATION_PREFS_COOKIE });
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
    for (const sidebarOpen of [false, true]) {
      const state = sidebarOpen ? "expanded" : "collapsed";
      await toggle.click();
      await expect(sidebar).toHaveAttribute("data-state", state);
      await expect
        .poll(async () => {
          const cookie = (await context.cookies()).find(
            ({ name }) => name === PRESENTATION_PREFS_COOKIE,
          );
          if (!cookie) {
            return null;
          }
          expect(cookie.httpOnly).toBe(true);
          return parsePresentationPrefs(decodeURIComponent(cookie.value))
            .sidebarOpen;
        })
        .toBe(sidebarOpen);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(sidebar).toHaveAttribute("data-state", state);
    }
  });
}

test("an existing sidebar cookie keeps its first-paint state until a unified preference replaces it", async ({
  baseURL,
  page,
}) => {
  if (baseURL === undefined) {
    throw new Error("Sidebar migration requires a base URL");
  }
  const context = page.context();
  await context.clearCookies({ name: PRESENTATION_PREFS_COOKIE });
  await context.addCookies([
    { name: SIDEBAR_STATE_COOKIE, value: "collapsed", url: baseURL },
  ]);
  const scripts = Promise.withResolvers<undefined>();
  await page.route("**/assets/*.js", async (route) => {
    await scripts.promise;
    await route.fallback();
  });
  await page.goto("/law", { waitUntil: "commit" });
  const sidebar = page.locator('[data-slot="sidebar"]');
  try {
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await expect(
      sidebar.locator('[data-slot="sidebar-header"]').getByRole("button"),
    ).toBeDisabled();
  } finally {
    scripts.resolve(undefined);
  }
  await sidebar
    .locator('[data-slot="sidebar-header"]')
    .getByRole("button")
    .click();
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
  await expect
    .poll(async () => (await context.cookies()).map(({ name }) => name))
    .toContain(PRESENTATION_PREFS_COOKIE);
  expect(
    (await context.cookies()).some(({ name }) => name === SIDEBAR_STATE_COOKIE),
  ).toBe(false);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(sidebar).toHaveAttribute("data-state", "expanded");
});

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

  test("profile locale activates without hydration errors", async ({
    page,
    baseURL,
  }) => {
    const fixedBrowserDate = new Date();
    fixedBrowserDate.setUTCHours(2, 0, 0, 0);
    const expectedToday = new Date(fixedBrowserDate.getTime() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    await setFixedBrowserTime(page, fixedBrowserDate);
    const profileSession = await createProfileTestSession({
      page,
      label: "law-locale-hydration",
      webUrl: baseURL ?? "http://localhost:3000",
    });
    try {
      await page.goto("/settings/account/profile", {
        waitUntil: "domcontentloaded",
      });
      await page.locator("#language-select").click();
      await page.getByRole("option", { name: "Čeština", exact: true }).click();
      await expect
        .poll(async () => {
          const response = await page.request.get(
            `${E2E_API_ORIGIN}/api/auth/get-session`,
          );
          expect(response.ok()).toBe(true);
          const session = await response.json();
          return session?.user?.locale ?? null;
        })
        .toBe("cs");
      await page.goto("/law?country=cze", { waitUntil: "commit" });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "cs");
      await openGlobalSearchDatePicker(page);

      await expect(
        page.locator('[role="gridcell"][aria-current="date"]'),
      ).toHaveAttribute("data-date", expectedToday);
    } finally {
      await profileSession.cleanup();
    }
  });
});
