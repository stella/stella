import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiDelete, apiUploadTemplate } from "../helpers/api";
import { expect, test } from "../helpers/test";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");
const FIT_DOCX_PATH = path.resolve(
  import.meta.dirname,
  "../fixtures/template-fit.docx",
);
const TEMPLATE_STUDIO_TEST_TIMEOUT_MS = 120_000;

test.describe("Template Studio", () => {
  test("fits the page to the viewport when the outline opens and the window narrows", async ({
    page,
    request,
  }) => {
    test.setTimeout(TEMPLATE_STUDIO_TEST_TIMEOUT_MS);
    let templateId: string | null = null;
    try {
      const templateName = `Template Studio Fit E2E ${randomUUID()}`;
      const uploadedTemplate = await apiUploadTemplate(request, {
        file: {
          name: "template-studio-fit-e2e.docx",
          mimeType: DOCX_MIME,
          buffer: await readFile(FIT_DOCX_PATH),
        },
        name: templateName,
      });
      templateId = uploadedTemplate.id;

      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto("/knowledge/templates", {
        waitUntil: "domcontentloaded",
      });
      const template = page.getByRole("button", {
        name: templateName,
        exact: true,
      });
      await expect(template).toBeVisible({ timeout: 45_000 });
      await template.click();
      const editor = page.getByTestId("folio-editor");
      await expect(editor.locator("[data-page-number]").first()).toBeVisible({
        timeout: 45_000,
      });
      await expect(
        page
          .locator('[data-slot="inspector"]')
          .getByRole("button", { name: "Close", exact: true }),
      ).toBeVisible();

      const viewport = editor.locator("[data-folio-scroll]");
      const expectPageFits = async () => {
        await expect
          .poll(async () => {
            const viewportBox = await viewport.boundingBox();
            const documentPage = await editor
              .locator("[data-page-number]")
              .first()
              .boundingBox();
            return viewportBox && documentPage
              ? documentPage.width <= viewportBox.width
              : false;
          })
          .toBe(true);
      };
      await expectPageFits();
      const closedViewport = await viewport.boundingBox();
      if (!closedViewport) {
        throw new Error("Template viewport did not mount");
      }
      await page.getByTestId("toolbar-outline-toggle").click();
      await expect(
        page.getByTestId("folio-outline").locator("select"),
      ).toBeVisible();
      await expect
        .poll(async () => (await viewport.boundingBox())?.width)
        .toBeLessThan(closedViewport.width);
      await expectPageFits();

      await page.mouse.move(0, 0);
      await page.setViewportSize({ width: 600, height: 1000 });
      const inspectorBack = page.getByRole("button", {
        name: "Back",
        exact: true,
      });
      await expect(inspectorBack).toBeVisible();
      await inspectorBack.click();
      await expect(inspectorBack).toBeHidden();
      await expectPageFits();
    } finally {
      if (templateId !== null) {
        await apiDelete(request, `/templates/${templateId}`);
      }
    }
  });

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
      const historyLengthBeforeOpen = await page.evaluate(
        () => window.history.length,
      );
      await templateButton.click();
      await expect(page).toHaveURL(
        `/knowledge/templates?template=${template.id}`,
      );
      expect(await page.evaluate(() => window.history.length)).toBe(
        historyLengthBeforeOpen,
      );

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
      const saveCompleted = page.getByRole("heading", {
        exact: true,
        name: "Template saved",
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
      // The response event precedes Eden response parsing and the page's
      // dirty-state reconciliation. The success toast is the explicit product
      // signal that the save action (including deferred clause renames) won.
      await expect(saveCompleted).toBeVisible();
      await expect(saveButton).toHaveCount(0);

      // The open template is in the URL, so the reload lands back in its
      // Studio rather than on the list.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(
        `/knowledge/templates?template=${template.id}`,
      );

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
