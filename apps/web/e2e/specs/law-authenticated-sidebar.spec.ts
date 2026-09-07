import { openGlobalSearchDatePicker } from "../helpers/global-search";
import { expect, test } from "../helpers/test";
import { createTestWorkspace, deleteTestWorkspace } from "../helpers/workspace";

const MACOS_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

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
    await page.clock.setFixedTime(fixedBrowserDate);
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
