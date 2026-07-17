import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiDelete, apiUploadTemplate } from "../helpers/api";
import { expect, test } from "../helpers/test";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");
const TEMPLATE_STUDIO_TEST_TIMEOUT_MS = 120_000;

test.describe("Template Studio", () => {
  test("persists document edits and conditions across reload", async ({
    page,
    request,
  }) => {
    test.setTimeout(TEMPLATE_STUDIO_TEST_TIMEOUT_MS);

    let templateId: string | null = null;
    try {
      const testToken = randomUUID().replaceAll("-", "");
      const templateName = `Template Studio E2E ${testToken}`;
      const editToken = ` E2EEDIT${testToken}`;
      const conditionName = `e2e_condition_${testToken}`;
      const docxBuffer = await readFile(DOCX_PATH);
      const template = await apiUploadTemplate(request, {
        file: {
          name: "template-studio-e2e.docx",
          mimeType: DOCX_MIME,
          buffer: docxBuffer,
        },
        name: templateName,
      });
      templateId = template.id;

      await page.goto("/knowledge/templates", {
        waitUntil: "domcontentloaded",
      });

      const templateButton = page.getByRole("button", {
        exact: true,
        name: templateName,
      });
      await expect(templateButton).toBeVisible({ timeout: 30_000 });
      await templateButton.click();

      const fixtureText = page.locator(".layout-run-text", {
        hasText: "Stella E2E test document.",
      });
      await expect(fixtureText).toBeVisible({ timeout: 45_000 });
      await fixtureText.click();
      await page.keyboard.insertText(editToken);
      await expect(
        page.locator(".layout-run-text", { hasText: editToken.trim() }),
      ).toBeVisible({ timeout: 20_000 });

      const documentEditor = page.getByRole("textbox", {
        name: "Document content",
      });
      await page.getByRole("button", { exact: true, name: "Insert" }).click();
      await page
        .getByRole("menuitem", { exact: true, name: "Condition" })
        .click();
      await expect(documentEditor).toBeFocused();
      await page.keyboard.insertText(conditionName);
      await expect(documentEditor).toContainText(conditionName);

      const saveButton = page.getByRole("button", {
        exact: true,
        name: "Save",
      });
      const saveResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith(
            `/v1/templates/${template.id}/document`,
          ),
        { timeout: 45_000 },
      );
      await saveButton.click();
      expect((await saveResponse).ok()).toBe(true);
      await expect(saveButton).toHaveCount(0);

      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(templateButton).toBeVisible({ timeout: 30_000 });
      await templateButton.click();

      await expect(
        page.locator(".layout-run-text", { hasText: editToken.trim() }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(documentEditor).toContainText(conditionName);
    } finally {
      if (templateId !== null) {
        await apiDelete(request, `/templates/${templateId}`);
      }
    }
  });
});
