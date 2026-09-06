import { randomUUID } from "node:crypto";
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

test.describe("find in table", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "table-search");
  });

  test.afterEach(async ({ request }) => {
    if (workspace === null) {
      return;
    }

    await deleteTestWorkspace(request, workspace.id);
    workspace = null;
  });

  test("Cmd/Ctrl+F narrows the rows to the term and marks it", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const suffix = randomUUID().slice(0, 8);
    const matchingName = `alpha-lease-${suffix}.docx`;
    const otherName = `beta-invoice-${suffix}.docx`;
    const docx = await readFile(DOCX_PATH);

    await Promise.all(
      [matchingName, otherName].map(
        async (name) =>
          await apiUploadDocx(
            request,
            testWorkspace.id,
            testWorkspace.filePropertyId,
            { name, mimeType: DOCX_MIME, buffer: docx },
          ),
      ),
    );

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

    const tableTab = page.getByRole("tab", { exact: true, name: "Table" });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await tableTab.click();

    const matchingRow = page.getByRole("button", {
      exact: true,
      name: matchingName,
    });
    const otherRow = page.getByRole("button", { exact: true, name: otherName });
    await expect(matchingRow).toBeVisible({ timeout: 30_000 });
    await expect(otherRow).toBeVisible();

    await page.keyboard.press("ControlOrMeta+f");
    const findInput = page.getByRole("searchbox");
    await expect(findInput).toBeFocused();

    await findInput.fill("alpha");

    await expect(otherRow).toBeHidden({ timeout: 15_000 });
    await expect(matchingRow).toBeVisible();
    await expect(page.locator("mark").first()).toHaveText("alpha");

    // Escape closes the bar, not the find: the rows stay narrowed and the
    // chip is what now says why.
    await findInput.press("Escape");
    await expect(findInput).toBeHidden();
    const findChip = page.getByRole("button", { exact: true, name: "alpha" });
    await expect(findChip).toBeVisible();
    await expect(otherRow).toBeHidden();
    await expect(page.locator("mark").first()).toHaveText("alpha");

    // The chip reopens the bar on the term it applied.
    await findChip.click();
    await expect(findInput).toHaveValue("alpha");

    // An outside press is the same story: Base UI closes the popover on any
    // click elsewhere, which is how opening a matched row used to drop it.
    await tableTab.click();
    await expect(findInput).toBeHidden();
    await expect(otherRow).toBeHidden();
    await expect(page.locator("mark").first()).toHaveText("alpha");

    await findChip
      .locator("xpath=..")
      .getByRole("button", { exact: true, name: "Remove" })
      .click();
    await expect(findChip).toBeHidden();
    await expect(otherRow).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("mark")).toHaveCount(0);
  });
});
