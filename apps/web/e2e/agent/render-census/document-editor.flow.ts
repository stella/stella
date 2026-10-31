import { expect } from "@playwright/test";

import { apiUploadDocx } from "../../helpers/api";
import { deleteTestWorkspace } from "../../helpers/workspace";
import type { DriveScriptContext } from "../drive-context";
import { createOutlineDocument } from "./document-fixture";
import { createLegalMatter } from "./fixture-setup";
import { DOCUMENT_NAME, INSERTED_TEXT, legalClause } from "./legal-fixtures";

const runDocumentEditorCensus = async ({
  page,
  measureAction,
}: DriveScriptContext) => {
  const matter = await createLegalMatter(
    page.request,
    "Smluvní podmínky převzetí a správy areálu",
  );
  try {
    await apiUploadDocx(page.request, matter.id, matter.filePropertyId, {
      name: DOCUMENT_NAME,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: await createOutlineDocument(),
    });
    await page.goto(`/workspaces/${matter.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("tab", { name: "Table", exact: true }).click();
    const file = page.getByRole("button", {
      name: DOCUMENT_NAME,
      exact: true,
    });
    await expect(file).toBeVisible({ timeout: 30_000 });
    await measureAction("document: open 80 pages / 230 headings", async () => {
      await file.click();
      await expect(
        page
          .locator(".layout-run-text")
          .filter({ hasText: legalClause(0).paragraph.slice(0, 40) })
          .first(),
      ).toBeVisible({ timeout: 60_000 });
    });
    const outline = page.getByTestId("folio-outline");
    if (!(await outline.isVisible())) {
      await page.getByTestId("toolbar-outline-toggle").click();
    }
    await expect(outline).toBeVisible();
    await expect(outline.getByText(/^Článek \d+\./u)).toHaveCount(230);
    // Clicking the painted paragraph unlocks the current document for editing.
    const paragraph = page
      .locator(".layout-run-text")
      .filter({ hasText: legalClause(0).paragraph.slice(0, 40) })
      .first();
    await paragraph.click();
    await expect(
      page.locator('[aria-label="Document content"]'),
    ).toHaveAttribute("contenteditable", "true");
    await paragraph.click();
    await page.keyboard.press("End");
    await measureAction("document: type 20 characters", async () => {
      await page.keyboard.type(INSERTED_TEXT);
      await expect(
        page.locator('[aria-label="Document content"]'),
      ).toContainText(INSERTED_TEXT);
    });
    await measureAction("document: select word and toggle bold", async () => {
      await page.keyboard.press("ArrowLeft");
      for (let character = 0; character < "rozsahu".length; character++) {
        await page.keyboard.press("Shift+ArrowLeft");
      }
      await page.keyboard.press("ControlOrMeta+b");
      await expect(
        page
          .locator('[aria-label="Document content"] strong')
          .filter({ hasText: "rozsahu" }),
      ).toHaveCount(1);
    });
    await paragraph.click();
    await measureAction("document: paragraph to heading", async () => {
      await page.keyboard.press("ControlOrMeta+Alt+1");
      await expect(
        page
          .locator('[aria-label="Document content"] h1')
          .filter({ hasText: legalClause(0).paragraph.slice(0, 40) }),
      ).toHaveCount(1);
    });
    await measureAction("document: outline jump", async () => {
      await page
        .getByTestId("folio-outline")
        .getByText(legalClause(99).heading, { exact: true })
        .click();
      await expect(
        page
          .locator(".layout-run-text")
          .filter({ hasText: "Článek 100." })
          .first(),
      ).toBeInViewport();
    });
  } finally {
    await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
    await deleteTestWorkspace(page.request, matter.id);
  }
};

export default runDocumentEditorCensus;
