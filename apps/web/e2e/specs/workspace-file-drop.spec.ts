import path from "node:path";

import { apiStatus } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");

test.describe("workspace file drop", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "workspace-file-drop");
  });

  test.afterEach(async ({ request }) => {
    if (workspace === null) {
      return;
    }

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

    const cdp = await page.context().newCDPSession(page);
    const dragData = {
      dragOperationsMask: 1,
      files: [DOCX_PATH],
      items: [],
    };
    const x = shellBox.x + shellBox.width / 2;
    const y = shellBox.y + shellBox.height - 16;

    await cdp.send("Input.dispatchDragEvent", {
      type: "dragEnter",
      x,
      y,
      data: dragData,
    });
    await cdp.send("Input.dispatchDragEvent", {
      type: "dragOver",
      x,
      y,
      data: dragData,
    });
    await cdp.send("Input.dispatchDragEvent", {
      type: "drop",
      x,
      y,
      data: dragData,
    });

    await expect(
      shellContent.getByRole("button", { name: /^simple\.docx\b/u }),
    ).toBeVisible({ timeout: 60_000 });
  });
});
