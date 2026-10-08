import type { APIRequestContext, Page, Request } from "@playwright/test";
import path from "node:path";

import { apiPut, apiStatus } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");

type DragData = {
  dragOperationsMask: number;
  files: string[];
  items: never[];
};

const dropNativeFiles = async (
  page: Page,
  point: { x: number; y: number },
  data: DragData,
) => {
  const cdp = await page.context().newCDPSession(page);
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, ...point, data });
  }
};

const openFilesView = async (
  page: Page,
  request: APIRequestContext,
  testWorkspace: TestWorkspace,
) => {
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
  await page.goto(`/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("tab", { exact: true, name: "Files" }).click();
};

const createFolder = async (
  request: APIRequestContext,
  workspaceId: string,
  name: string,
) =>
  await apiPut<{ entityId: string }>(request, `/entities/${workspaceId}`, {
    name,
    kind: "folder",
  });

const uploadParentId = (uploadRequest: Request): unknown => {
  const body: unknown = uploadRequest.postDataJSON();
  return typeof body === "object" && body !== null && "parentId" in body
    ? body.parentId
    : undefined;
};

test.describe("workspace file drop", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "workspace-file-drop");
  });

  test.afterEach(async ({ page, request }) => {
    if (workspace === null) {
      return;
    }

    // The upload starts follow-up work from the open page; close it first so
    // nothing it sends can race the matter's deletion.
    await page.close();
    await deleteTestWorkspace(request, workspace.id);
    workspace = null;
  });

  test("the complete Files viewport accepts native file drops", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    await openFilesView(page, request, testWorkspace);
    await expect(
      page.getByRole("heading", { name: "Upload your first documents" }),
    ).toBeVisible({ timeout: 30_000 });

    const shellContent = page.locator('[data-slot="workspace-shell-content"]');
    const dropZone = shellContent.locator(
      ':scope > [data-slot="file-drop-zone"]',
    );
    await expect(dropZone).toHaveCount(1);

    const shellBox = await shellContent.boundingBox();
    const dropZoneBox = await dropZone.boundingBox();
    if (shellBox === null || dropZoneBox === null) {
      throw new Error("Workspace file drop geometry is unavailable");
    }

    expect(dropZoneBox.x).toBeCloseTo(shellBox.x, 0);
    expect(dropZoneBox.y).toBeCloseTo(shellBox.y, 0);
    expect(dropZoneBox.width).toBeCloseTo(shellBox.width, 0);
    expect(dropZoneBox.height).toBeGreaterThanOrEqual(shellBox.height);

    await dropNativeFiles(
      page,
      {
        x: shellBox.x + shellBox.width / 2,
        y: shellBox.y + shellBox.height - 16,
      },
      { dragOperationsMask: 1, files: [DOCX_PATH], items: [] },
    );

    await expect(
      shellContent.getByRole("button", { name: /^simple\.docx\b/u }),
    ).toBeVisible({ timeout: 60_000 });
  });
  test("a native file dropped on a folder row uploads into that folder", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }
    const folderName = "Drop target folder";
    const folder = await createFolder(request, testWorkspace.id, folderName);

    await openFilesView(page, request, testWorkspace);
    const folderLabel = page.getByTitle(folderName, { exact: true });
    await expect(folderLabel).toBeVisible({ timeout: 30_000 });
    const folderBox = await folderLabel.boundingBox();
    if (folderBox === null) {
      throw new Error("Folder row geometry is unavailable");
    }

    const upload = page.waitForRequest(
      (candidate) =>
        candidate.method() === "POST" &&
        candidate.url().endsWith("/entity-create/tree"),
    );
    await dropNativeFiles(
      page,
      {
        x: folderBox.x + folderBox.width / 2,
        y: folderBox.y + folderBox.height / 2,
      },
      { dragOperationsMask: 1, files: [DOCX_PATH], items: [] },
    );
    expect(uploadParentId(await upload)).toBe(folder.entityId);

    await folderLabel.dblclick();
    await expect(
      page.getByRole("button", { name: /^simple\.docx\b/u }),
    ).toBeVisible({ timeout: 60_000 });
  });

  test("the keyboard upload inside a folder still targets that folder", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }
    const folderName = "Keyboard target folder";
    const folder = await createFolder(request, testWorkspace.id, folderName);

    await openFilesView(page, request, testWorkspace);
    const folderLabel = page.getByTitle(folderName, { exact: true });
    await expect(folderLabel).toBeVisible({ timeout: 30_000 });
    await folderLabel.dblclick();

    const shellContent = page.locator('[data-slot="workspace-shell-content"]');
    // The view switcher and sort toolbar also expose "Add" via aria-label, and
    // the tree renders a hidden context-menu anchor; the real add menu is the
    // visible button named by its own text.
    const addButton = shellContent
      .getByRole("button", { exact: true, name: "Add" })
      .and(page.locator(":not([aria-label])"))
      .filter({ visible: true });
    await addButton.focus();
    await page.keyboard.press("Enter");
    const uploadItem = page.getByRole("menuitem", {
      exact: true,
      name: "Upload files",
    });
    await expect(uploadItem).toBeVisible();
    await uploadItem.focus();

    const chooser = page.waitForEvent("filechooser");
    const presign = page.waitForRequest(
      (candidate) =>
        candidate.method() === "POST" && candidate.url().endsWith("/presign"),
    );
    await page.keyboard.press("Enter");
    await (await chooser).setFiles(DOCX_PATH);
    expect(uploadParentId(await presign)).toBe(folder.entityId);
  });
});
