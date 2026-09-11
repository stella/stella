import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { apiDelete, apiGet, apiPut, apiStatus } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const TABLE_STORE_KEY = "stella:table";

type ViewSummary = { id: string; layout: { type: string } };

type PersistedTableState = {
  state: { contentMode: Record<string, Record<string, string>> };
  version: number;
};

const readTableStore = async (
  page: Page,
): Promise<PersistedTableState | null> =>
  await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as PersistedTableState);
  }, TABLE_STORE_KEY);

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

  // A view deleted while this browser was not looking (another client, the
  // CLI, MCP, or a closed tab) leaves its saved column widths and content
  // mode behind. The next fetch of the matter's views reconciles the store,
  // so a reload is enough to drop them, and only them.
  test("a deleted view's saved state is dropped on the next views fetch", async ({
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
    const views = await apiGet<ViewSummary[]>(
      request,
      `/views/${testWorkspace.id}`,
    );
    const tableView = views.find(
      (view) => view.layout.type === "table" && view.id !== secondViewId,
    );
    if (!tableView) {
      throw new Error("Workspace has no default table view");
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

    await page.goto(`/workspaces/${testWorkspace.id}/${tableView.id}`, {
      waitUntil: "domcontentloaded",
    });

    const tableTab = page.getByRole("tab", { exact: true, name: "Table" });
    const secondTab = page.getByRole("tab", {
      exact: true,
      name: secondViewName,
    });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await expect(secondTab).toBeVisible();

    // Content mode is persisted with the column widths and is one click to
    // set, so it stands in for a resize here. Set it on both table views.
    const wrapContent = page.getByRole("button", {
      exact: true,
      name: "Wrap content",
    });
    await expect(wrapContent).toBeVisible();
    await wrapContent.click();
    await expect(wrapContent).toHaveAttribute("aria-pressed", "true");

    await secondTab.click();
    await expect(secondTab).toHaveAttribute("aria-selected", "true");
    await expect(wrapContent).toHaveAttribute("aria-pressed", "false");
    await wrapContent.click();
    await expect(wrapContent).toHaveAttribute("aria-pressed", "true");

    await expect
      .poll(
        async () =>
          (await readTableStore(page))?.state.contentMode[testWorkspace.id],
        { message: "both views' content mode reached storage" },
      )
      .toEqual({
        [tableView.id]: "fit-content",
        [secondViewId]: "fit-content",
      });

    // Deleted behind the browser's back: no mutation or realtime event in
    // this tab knows about it.
    await apiDelete(request, `/views/${testWorkspace.id}/view/${secondViewId}`);

    await page.goto(`/workspaces/${testWorkspace.id}/${tableView.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await expect(secondTab).toBeHidden();

    await expect
      .poll(async () => await readTableStore(page), {
        message: "the deleted view's state is gone and the other's kept",
      })
      .toMatchObject({
        state: {
          contentMode: {
            [testWorkspace.id]: { [tableView.id]: "fit-content" },
          },
        },
        version: 1,
      });
    const stored = await readTableStore(page);
    expect(stored?.state.contentMode[testWorkspace.id]).toEqual({
      [tableView.id]: "fit-content",
    });
  });

  // The shape before matter keying is not migrated: it reads as an empty
  // store, without a `persist` error, and the first change rewrites the key
  // at the current version.
  test("storage from before matter keying resets once, silently", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const views = await apiGet<ViewSummary[]>(
      request,
      `/views/${testWorkspace.id}`,
    );
    const tableView = views.find((view) => view.layout.type === "table");
    if (!tableView) {
      throw new Error("Workspace has no default table view");
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

    const legacy = JSON.stringify({
      state: {
        columnSizing: { __map: [[tableView.id, { name: 420 }]] },
        contentMode: { [tableView.id]: "fit-content" },
      },
      version: 0,
    });
    await page.addInitScript(
      ({ key, value }) => {
        if (localStorage.getItem(key) === null) {
          localStorage.setItem(key, value);
        }
      },
      { key: TABLE_STORE_KEY, value: legacy },
    );

    await page.goto(`/workspaces/${testWorkspace.id}/${tableView.id}`, {
      waitUntil: "domcontentloaded",
    });
    const tableTab = page.getByRole("tab", { exact: true, name: "Table" });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });

    // The old payload's mode is not honoured: the store started empty.
    const wrapContent = page.getByRole("button", {
      exact: true,
      name: "Wrap content",
    });
    await expect(wrapContent).toBeVisible();
    await expect(wrapContent).toHaveAttribute("aria-pressed", "false");

    await wrapContent.click();
    await expect(wrapContent).toHaveAttribute("aria-pressed", "true");

    await expect
      .poll(async () => await readTableStore(page), {
        message: "the key is rewritten at the current version",
      })
      .toEqual({
        state: {
          columnSizing: {},
          contentMode: {
            [testWorkspace.id]: { [tableView.id]: "fit-content" },
          },
        },
        version: 1,
      });
  });
});
