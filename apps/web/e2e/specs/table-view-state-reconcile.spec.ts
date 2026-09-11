import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { apiDelete, apiPut, apiStatus } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const readContentModes = async (page: Page) =>
  await page.evaluate(() => {
    const raw = localStorage.getItem("stella:table");
    return raw === null
      ? null
      : (
          JSON.parse(raw) as {
            state: { contentMode: Record<string, Record<string, string>> };
          }
        ).state.contentMode;
  });

test.describe("per-view table state", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "table-view-state");
  });

  test.afterEach(async ({ request }) => {
    if (workspace === null) {
      return;
    }

    await deleteTestWorkspace(request, workspace.id);
    workspace = null;
  });

  test("a view deleted behind the browser's back loses its saved state on reload", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const secondViewId = randomUUID();
    const secondViewName = `Second ${secondViewId.slice(0, 8)}`;
    await apiPut(request, `/views/${testWorkspace.id}`, {
      id: secondViewId,
      name: secondViewName,
      layout: {
        type: "table",
        version: 1,
        columnOrder: [],
        columnPinning: [testWorkspace.filePropertyId],
        filters: [],
        sorts: [],
        hiddenProperties: [],
      },
    });

    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        {
          message: "browser context can read the created workspace",
          timeout: 10_000,
        },
      )
      .toBe(200);

    const viewUrl = `/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`;
    await page.goto(viewUrl, { waitUntil: "domcontentloaded" });

    const tableTab = page.getByRole("tab", { exact: true, name: "Table" });
    const secondTab = page.getByRole("tab", {
      exact: true,
      name: secondViewName,
    });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await expect(secondTab).toBeVisible();

    // Content mode is persisted alongside column widths and is one click to
    // set, so it stands in for a resize. Set it on both views.
    const wrapContent = page.getByRole("button", {
      exact: true,
      name: "Wrap content",
    });
    await wrapContent.click();
    await expect(wrapContent).toHaveAttribute("aria-pressed", "true");
    await secondTab.click();
    await expect(wrapContent).toHaveAttribute("aria-pressed", "false");
    await wrapContent.click();
    await expect(wrapContent).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await readContentModes(page))?.[testWorkspace.id], {
        message: "both views' content mode reached storage",
      })
      .toEqual({
        [testWorkspace.viewId]: "fit-content",
        [secondViewId]: "fit-content",
      });

    await apiDelete(request, `/views/${testWorkspace.id}/view/${secondViewId}`);

    await page.goto(viewUrl, { waitUntil: "domcontentloaded" });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await expect(secondTab).toBeHidden();
    await expect
      .poll(async () => (await readContentModes(page))?.[testWorkspace.id], {
        message: "the deleted view's state is gone and the other's kept",
      })
      .toEqual({ [testWorkspace.viewId]: "fit-content" });
  });
});
