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

const namedView = (label: string) => {
  const id = randomUUID();
  return { id, name: `${label} ${id.slice(0, 8)}` };
};

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

    // Both views are created here rather than reusing the matter's own: the
    // first auto-created view is the overview, which has no table toolbar.
    const firstView = namedView("First");
    const secondView = namedView("Second");
    for (const { id, name } of [firstView, secondView]) {
      await apiPut(request, `/views/${testWorkspace.id}`, {
        id,
        name,
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
    }

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

    const viewUrl = `/workspaces/${testWorkspace.id}/${firstView.id}`;
    await page.goto(viewUrl, { waitUntil: "domcontentloaded" });

    const firstTab = page.getByRole("tab", {
      exact: true,
      name: firstView.name,
    });
    const secondTab = page.getByRole("tab", {
      exact: true,
      name: secondView.name,
    });
    await expect(firstTab).toBeVisible({ timeout: 30_000 });
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
        [firstView.id]: "fit-content",
        [secondView.id]: "fit-content",
      });

    await apiDelete(
      request,
      `/views/${testWorkspace.id}/view/${secondView.id}`,
    );

    await page.goto(viewUrl, { waitUntil: "domcontentloaded" });
    await expect(firstTab).toBeVisible({ timeout: 30_000 });
    await expect(secondTab).toBeHidden();
    await expect
      .poll(async () => (await readContentModes(page))?.[testWorkspace.id], {
        message: "the deleted view's state is gone and the other's kept",
      })
      .toEqual({ [firstView.id]: "fit-content" });
  });
});
