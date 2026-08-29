import type { BrowserContext, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiGet, apiUploadDocx } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const STORAGE_STATE = path.resolve(REPO_ROOT, ".playwright/storage-state.json");
const WEB_BASE_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:3000";

type EntityFileField = {
  id: string;
  propertyId: string;
  content: { type: string };
};

type EntityWithFields = {
  fields: EntityFileField[];
};

const readDocumentText = async (page: Page) =>
  (await page.locator(".layout-run-text").allTextContents()).join("");

const openCollaborativeDocument = async ({
  entityId,
  fieldId,
  page,
  viewId,
  workspaceId,
}: {
  entityId: string;
  fieldId: string;
  page: Page;
  viewId: string;
  workspaceId: string;
}) => {
  await page.goto(
    `/workspaces/${workspaceId}/${viewId}/document` +
      `?entity=${entityId}&field=${fieldId}&editing=true`,
    { timeout: 90_000, waitUntil: "commit" },
  );
  await expect(
    page.getByRole("button", { exact: true, name: "Create version" }).first(),
  ).toBeEnabled({ timeout: 45_000 });
  await expect(
    page.getByRole("status").filter({ hasText: "Synced" }).first(),
  ).toBeVisible();
  await expect(
    page.locator(".layout-run-text", {
      hasText: "Stella E2E test document.",
    }),
  ).toBeVisible({ timeout: 45_000 });
};

test.describe("lockless DOCX collaboration", () => {
  let collaboratorContext: BrowserContext | null = null;
  let workspace: TestWorkspace | null = null;

  test.afterEach(async ({ request }) => {
    await collaboratorContext?.close();
    collaboratorContext = null;
    if (workspace !== null) {
      await deleteTestWorkspace(request, workspace.id);
      workspace = null;
    }
  });

  test("two browser contexts converge and publishing keeps both editors open", async ({
    browser,
    browserErrors,
    page,
    request,
  }) => {
    workspace = await createTestWorkspace(request, "folio-collaboration");
    const testWorkspace = workspace;
    const docxBuffer = await readFile(DOCX_PATH);
    const uploaded = await apiUploadDocx(
      request,
      testWorkspace.id,
      testWorkspace.filePropertyId,
      {
        name: "stella-collaboration-e2e.docx",
        mimeType: DOCX_MIME,
        buffer: docxBuffer,
      },
    );
    const entity = await apiGet<EntityWithFields>(
      request,
      `/entities/${testWorkspace.id}/entity/${uploaded.entityId}`,
    );
    const fileField = entity.fields.find(
      (field) =>
        field.propertyId === testWorkspace.filePropertyId &&
        field.content.type === "file",
    );
    if (fileField === undefined) {
      throw new Error("Uploaded entity has no matching DOCX file field.");
    }

    collaboratorContext = await browser.newContext({
      baseURL: WEB_BASE_URL,
      storageState: STORAGE_STATE,
    });
    const collaboratorPage = await collaboratorContext.newPage();
    const stopTrackingCollaborator = browserErrors.trackPage(collaboratorPage);

    try {
      await openCollaborativeDocument({
        entityId: uploaded.entityId,
        fieldId: fileField.id,
        page,
        viewId: testWorkspace.viewId,
        workspaceId: testWorkspace.id,
      });
      await openCollaborativeDocument({
        entityId: uploaded.entityId,
        fieldId: fileField.id,
        page: collaboratorPage,
        viewId: testWorkspace.viewId,
        workspaceId: testWorkspace.id,
      });

      const firstParagraph = page.locator(".layout-run-text", {
        hasText: "Stella E2E",
      });
      const collaboratorParagraph = collaboratorPage.locator(
        ".layout-run-text",
        { hasText: "Stella E2E" },
      );
      await firstParagraph.click();
      await collaboratorParagraph.click();
      await expect(page.locator(".ProseMirror-yjs-cursor")).toHaveCount(1);

      const firstToken = ` FIRST${String(Date.now())}`;
      await page.keyboard.type(firstToken);
      await expect
        .poll(async () => await readDocumentText(collaboratorPage))
        .toContain(firstToken);

      await firstParagraph.click();
      await collaboratorParagraph.click();
      const firstConcurrentToken = ` LEFT${String(Date.now())}`;
      const secondConcurrentToken = ` RIGHT${String(Date.now())}`;
      await Promise.all([
        page.keyboard.insertText(firstConcurrentToken),
        collaboratorPage.keyboard.insertText(secondConcurrentToken),
      ]);
      await expect
        .poll(async () => [
          await readDocumentText(page),
          await readDocumentText(collaboratorPage),
        ])
        .toEqual([
          expect.stringContaining(firstConcurrentToken),
          expect.stringContaining(firstConcurrentToken),
        ]);
      await expect
        .poll(async () => [
          await readDocumentText(page),
          await readDocumentText(collaboratorPage),
        ])
        .toEqual([
          expect.stringContaining(secondConcurrentToken),
          expect.stringContaining(secondConcurrentToken),
        ]);

      const publishResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/folio-collab-rooms/publish-version"),
        { timeout: 45_000 },
      );
      const whilePublishingToken = ` OPEN${String(Date.now())}`;
      await collaboratorParagraph.click();
      await Promise.all([
        page
          .getByRole("button", { exact: true, name: "Create version" })
          .first()
          .click(),
        collaboratorPage.keyboard.insertText(whilePublishingToken),
      ]);
      expect((await publishResponse).ok()).toBe(true);

      await expect
        .poll(async () => await readDocumentText(page))
        .toContain(whilePublishingToken);
      await expect(
        page
          .getByRole("button", { exact: true, name: "Create version" })
          .first(),
      ).toBeEnabled();
      await expect(
        collaboratorPage
          .getByRole("button", { exact: true, name: "Create version" })
          .first(),
      ).toBeEnabled();
    } finally {
      stopTrackingCollaborator();
    }
  });
});
