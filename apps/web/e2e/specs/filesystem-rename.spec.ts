import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiStatus, apiUploadDocx } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");
const LONG_BASE_NAME =
  "Postmoney Safe - Valuation Cap Only v1.1 (Singapore)-b4ed2ab41662c2c996943b630306b02fcbb86e7f5ec6ecc958250285cfd68";

test.describe("filesystem rename", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "filesystem-rename");
  });

  test.afterEach(async ({ request }) => {
    if (workspace === null) {
      return;
    }

    await deleteTestWorkspace(request, workspace.id);
    workspace = null;
  });

  test("long names remain editable and update immediately on Enter", async ({
    page,
    request,
  }) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    await apiUploadDocx(
      request,
      testWorkspace.id,
      testWorkspace.filePropertyId,
      {
        name: `${LONG_BASE_NAME}.docx`,
        mimeType: DOCX_MIME,
        buffer: await readFile(DOCX_PATH),
      },
    );

    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        { message: "browser context can read the created workspace" },
      )
      .toBe(200);

    await page.goto(`/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("tab", { exact: true, name: "Files" }).click();

    const originalName = page.getByTitle(`${LONG_BASE_NAME}.docx`, {
      exact: true,
    });
    await expect(originalName).toBeVisible({ timeout: 30_000 });
    await originalName.locator("xpath=ancestor::button[1]").click({
      button: "right",
    });
    await page.getByRole("menuitem", { exact: true, name: "Rename" }).click();

    const input = page.getByRole("textbox");
    await expect(input).toBeVisible();
    expect(
      await input.evaluate((element) => element.clientWidth),
    ).toBeGreaterThan(300);
    await expect(input.locator("xpath=ancestor::button")).toHaveCount(0);

    const inputBox = await input.boundingBox();
    if (inputBox === null) {
      throw new Error("Rename input has no bounding box");
    }
    await page.mouse.move(
      inputBox.x + inputBox.width * 0.2,
      inputBox.y + inputBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      inputBox.x + inputBox.width * 0.8,
      inputBox.y + inputBox.height / 2,
    );
    await page.mouse.up();
    expect(
      await input.evaluate(
        (element) =>
          element instanceof HTMLInputElement &&
          element.selectionEnd !== element.selectionStart,
      ),
    ).toBe(true);

    const renameRequest = Promise.withResolvers<undefined>();
    await page.route("**/v1/entities/*/rename", async (route) => {
      await renameRequest.promise;
      await route.continue();
    });

    const renamedBase = `${LONG_BASE_NAME}-renamed`;
    await input.fill(renamedBase);
    const renameResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().includes("/v1/entities/") &&
        response.url().endsWith("/rename"),
    );
    await input.press("Enter");

    const renamedName = page.getByTitle(`${renamedBase}.docx`, {
      exact: true,
    });
    await expect(renamedName).toBeVisible({ timeout: 1000 });

    renameRequest.resolve(undefined);
    expect((await renameResponse).status()).toBe(200);
    await expect(renamedName).toBeVisible();
  });
});
