import type { Page } from "@playwright/test";
import { panic } from "better-result";
import { readFile } from "node:fs/promises";
import path from "node:path";

import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { apiStatus, apiUploadDocx } from "../helpers/api";
import { openSavedView } from "../helpers/saved-views";
import { expect, test } from "../helpers/test";
import {
  PLAYWRIGHT_EXPECT_TIMEOUT_10_SECONDS_MS,
  PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
} from "../helpers/wait-budgets";
import {
  createTestWorkspace,
  deleteTestWorkspace,
  type TestWorkspace,
} from "../helpers/workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");
const FIRST = "Engagement letter";
const SECOND = "Closing checklist";

const HEADER = '[data-slot="inspector-panel-header"]:visible';

// A phone-width viewport: the inspector is a sheet, and its rail is hidden.
// Without touch emulation, so the table still lists the files to open.
test.use({ viewport: { width: 390, height: 844 } });

const openFromTable = async (page: Page, baseName: string) => {
  await page
    .locator('[data-slot="workspace-grid-cell"]')
    .getByRole("button", { exact: true, name: `${baseName}.docx` })
    .click();
  await expect(
    page.locator(HEADER).getByLabel(baseName, { exact: true }),
  ).toBeVisible({ timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS });
};

const switcherNamed = (page: Page, count: number) =>
  page.locator(HEADER).getByRole("button", {
    exact: true,
    name: messages.inspector.openTabs.replace("{count, number}", () =>
      String(count),
    ),
  });

test.describe("inspector tabs on a phone", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "phone-inspector-tabs");
  });

  test.afterEach(async ({ page, request }, testInfo) => {
    if (workspace === null) {
      return;
    }
    await deleteTestWorkspace(request, workspace.id, {
      leave: { page, testInfo },
    });
    workspace = null;
  });

  test("the header's tab switcher reaches every open tab", async ({
    page,
    request,
  }) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      panic("Test workspace was not created");
    }
    const buffer = await readFile(DOCX_PATH);
    for (const baseName of [FIRST, SECOND]) {
      await apiUploadDocx(
        request,
        testWorkspace.id,
        testWorkspace.filePropertyId,
        { name: `${baseName}.docx`, mimeType: DOCX_MIME, buffer },
      );
    }

    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        { timeout: PLAYWRIGHT_EXPECT_TIMEOUT_10_SECONDS_MS },
      )
      .toBe(200);
    await page.goto(`/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`, {
      waitUntil: "domcontentloaded",
    });
    await openSavedView(page, "Table", {
      timeout: PLAYWRIGHT_EXPECT_TIMEOUT_30_SECONDS_MS,
    });

    await openFromTable(page, FIRST);
    await page
      .locator(HEADER)
      .getByRole("button", { exact: true, name: messages.common.back })
      .click();
    await openFromTable(page, SECOND);

    // The rail is not on screen; the header's switcher is the way back.
    await switcherNamed(page, 2).click();
    const menu = page.getByRole("menu");
    const items = menu.getByRole("menuitemradio");
    await expect(items).toHaveText([
      new RegExp(FIRST, "u"),
      new RegExp(SECOND, "u"),
    ]);
    await expect(items.nth(1)).toHaveAttribute("aria-checked", "true");

    await items.nth(0).click();
    await expect(menu).toBeHidden();
    await expect(
      page.locator(HEADER).getByLabel(FIRST, { exact: true }),
    ).toBeVisible();
    // The pressed header was replaced; focus lands on the one now shown.
    await expect(switcherNamed(page, 2)).toBeFocused();

    // And by keyboard, back to the other tab.
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    // The menu takes focus a moment after it shows; a key pressed before
    // that reaches nothing.
    await expect(
      page.locator('[role="menu"]:focus, [role="menu"] :focus'),
    ).toHaveCount(1);
    await page.keyboard.press("End");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.locator(HEADER).getByLabel(SECOND, { exact: true }),
    ).toBeVisible();
    await expect(switcherNamed(page, 2)).toBeFocused();
  });
});
