import type { APIRequestContext } from "@playwright/test";
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  apiDownloadFileField,
  apiGet,
  apiStatus,
  apiUploadDocx,
} from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");

const readEvidenceMessages = async (locale: string) => {
  const catalog: unknown = JSON.parse(
    await readFile(
      path.resolve(import.meta.dirname, `../../src/i18n/langs/${locale}.json`),
      "utf-8",
    ),
  );
  if (
    typeof catalog !== "object" ||
    catalog === null ||
    !("folio" in catalog) ||
    typeof catalog.folio !== "object" ||
    catalog.folio === null ||
    !("finishEditing" in catalog.folio) ||
    typeof catalog.folio.finishEditing !== "string" ||
    !("evidenceReferences" in catalog.folio) ||
    typeof catalog.folio.evidenceReferences !== "string"
  ) {
    throw new Error(`Missing evidence test labels for ${locale}`);
  }
  return {
    finishEditing: catalog.folio.finishEditing,
    evidenceReferences: catalog.folio.evidenceReferences,
  };
};

type EntityFileField = {
  id: string;
  propertyId: string;
  content: { type: string; fileName?: string };
};

type EntityWithFields = { fields: EntityFileField[] };

const readEntity = async (
  request: APIRequestContext,
  workspaceId: string,
  entityId: string,
) =>
  await apiGet<EntityWithFields>(
    request,
    `/entities/${workspaceId}/entity/${entityId}`,
  );

const findFileFieldForProperty = (
  entity: EntityWithFields,
  propertyId: string,
) =>
  entity.fields.find(
    (field) => field.propertyId === propertyId && field.content.type === "file",
  );

const waitForFileFieldId = async (
  request: APIRequestContext,
  workspaceId: string,
  entityId: string,
  propertyId: string,
) => {
  const result: { fieldId: string | null } = { fieldId: null };
  await expect
    .poll(
      async () => {
        const entity = await readEntity(request, workspaceId, entityId);
        result.fieldId =
          findFileFieldForProperty(entity, propertyId)?.id ?? null;
        return result.fieldId;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();
  if (result.fieldId === null) {
    throw new Error("Saved file field was not created");
  }
  return result.fieldId;
};

const waitForDocumentContaining = async (
  request: APIRequestContext,
  workspaceId: string,
  entityId: string,
  propertyId: string,
  text: string,
) => {
  const result: { xml: string | null } = { xml: null };
  await expect
    .poll(
      async () => {
        const entity = await readEntity(request, workspaceId, entityId);
        const field = findFileFieldForProperty(entity, propertyId);
        if (field === undefined) {
          return false;
        }
        const xml = await readDocumentXml(
          await apiDownloadFileField(request, workspaceId, field.id),
        );
        if (!xml.includes(text)) {
          return false;
        }
        result.xml = xml;
        return true;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (result.xml === null) {
    throw new Error("Saved document was not updated");
  }
  return result.xml;
};

const readDocumentXml = async (docxBuffer: Buffer) => {
  const zip = await JSZip.loadAsync(docxBuffer);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (documentXml === undefined) {
    throw new Error("Saved DOCX is missing word/document.xml");
  }
  return documentXml;
};

for (const locale of ["cs", "en", "ar"] as const) {
  test.describe(`DOCX evidence references (${locale})`, () => {
    test.use({ locale });
    let workspace: TestWorkspace | null = null;

    test.beforeEach(async ({ request }) => {
      workspace = await createTestWorkspace(request, "evidence-references");
    });

    test.afterEach(async ({ page, request }) => {
      if (workspace === null) {
        return;
      }
      await page.goto("about:blank", { waitUntil: "commit" });
      await deleteTestWorkspace(request, workspace.id);
      workspace = null;
    });

    test("persists references, resolves the source, and renumbers after reload", async ({
      page,
      request,
    }) => {
      const messages = await readEvidenceMessages(locale);
      const testWorkspace = workspace;
      if (testWorkspace === null) {
        throw new Error("Test workspace was not created");
      }

      const docxBuffer = await readFile(DOCX_PATH);
      const sourceUpload = await apiUploadDocx(
        request,
        testWorkspace.id,
        testWorkspace.filePropertyId,
        {
          name: "evidence-source.docx",
          mimeType: DOCX_MIME,
          buffer: docxBuffer,
        },
      );
      const secondSourceUpload = await apiUploadDocx(
        request,
        testWorkspace.id,
        testWorkspace.filePropertyId,
        {
          name: "evidence-second-source.docx",
          mimeType: DOCX_MIME,
          buffer: docxBuffer,
        },
      );
      const pleadingUpload = await apiUploadDocx(
        request,
        testWorkspace.id,
        testWorkspace.filePropertyId,
        { name: "pleading.docx", mimeType: DOCX_MIME, buffer: docxBuffer },
      );

      const pleadingEntity = await readEntity(
        request,
        testWorkspace.id,
        pleadingUpload.entityId,
      );
      const pleadingField = findFileFieldForProperty(
        pleadingEntity,
        testWorkspace.filePropertyId,
      );
      expect(pleadingField, "pleading file field present").toBeTruthy();

      const sourceEntity = await readEntity(
        request,
        testWorkspace.id,
        sourceUpload.entityId,
      );
      const sourceField = findFileFieldForProperty(
        sourceEntity,
        testWorkspace.filePropertyId,
      );
      expect(sourceField, "source file field present").toBeTruthy();

      const secondSourceEntity = await readEntity(
        request,
        testWorkspace.id,
        secondSourceUpload.entityId,
      );
      const secondSourceField = findFileFieldForProperty(
        secondSourceEntity,
        testWorkspace.filePropertyId,
      );
      expect(
        secondSourceField,
        "second source file field present",
      ).toBeTruthy();

      const { cookies } = await request.storageState();
      await page.context().addCookies(cookies);
      await expect
        .poll(
          async () =>
            await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
          { timeout: 10_000 },
        )
        .toBe(200);

      const documentUrl =
        `/workspaces/${testWorkspace.id}/${testWorkspace.viewId}/document` +
        `?entity=${pleadingUpload.entityId}&field=${pleadingField!.id}&editing=true`;
      await page.goto(documentUrl, { waitUntil: "domcontentloaded" });

      const finishEditingButton = page.getByRole("button", {
        name: messages.finishEditing,
      });
      await expect(finishEditingButton).toBeEnabled({ timeout: 45_000 });
      await expect(
        page.locator(".layout-run-text", {
          hasText: "Stella E2E test document.",
        }),
      ).toBeVisible({ timeout: 45_000 });

      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("html")).toHaveAttribute(
        "dir",
        locale === "ar" ? "rtl" : "ltr",
      );

      const evidenceButton = page.getByRole("button", {
        name: messages.evidenceReferences,
      });
      await evidenceButton.click();
      const evidenceDialog = page.getByRole("dialog", {
        name: messages.evidenceReferences,
      });
      await expect(evidenceDialog).toBeVisible();
      await evidenceDialog
        .getByRole("button", { name: "evidence-source.docx", exact: true })
        .click();
      await expect(evidenceDialog).toBeHidden();

      await page
        .locator('[aria-label="Document content"]')
        .press("Control+End");
      await page.keyboard.type(": Faktura");
      await expect(
        page.locator(".layout-run-text", { hasText: "Důkaz 1" }),
      ).toBeVisible({ timeout: 20_000 });

      const finalizeResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/desktop-edit-sessions/") &&
          response.url().endsWith("/finalize"),
        { timeout: 45_000 },
      );
      await finishEditingButton.click();
      expect((await finalizeResponse).ok()).toBe(true);
      await expect(finishEditingButton).toBeHidden();

      const savedFieldId = await waitForFileFieldId(
        request,
        testWorkspace.id,
        pleadingUpload.entityId,
        testWorkspace.filePropertyId,
      );
      const savedXml = await readDocumentXml(
        await apiDownloadFileField(request, testWorkspace.id, savedFieldId),
      );
      expect(savedXml).toContain("STELLA_EVIDENCE_V1");
      expect(savedXml).toContain("Důkaz 1");
      expect(savedXml).toContain(": Faktura");

      await page.goto(
        `/workspaces/${testWorkspace.id}/${testWorkspace.viewId}/document` +
          `?entity=${pleadingUpload.entityId}&field=${savedFieldId}&editing=true`,
        { waitUntil: "domcontentloaded" },
      );
      await expect(finishEditingButton).toBeEnabled({ timeout: 45_000 });

      await evidenceButton.click();
      const reloadedDialog = page.getByRole("dialog", {
        name: messages.evidenceReferences,
      });
      const sourceRequest = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes(
              `/entities/${testWorkspace.id}/entity/${sourceUpload.entityId}/field/${sourceField!.id}/file`,
            ),
        { timeout: 30_000 },
      );
      await reloadedDialog
        .getByRole("button", {
          name: "Důkaz 1: evidence-source.docx",
          exact: true,
        })
        .click();
      expect((await sourceRequest).ok()).toBe(true);

      await page
        .locator('[aria-label="Document content"]')
        .press("Control+End");
      await evidenceButton.click();
      await reloadedDialog
        .getByRole("button", {
          name: "evidence-second-source.docx",
          exact: true,
        })
        .click();
      await expect(
        page.locator(".layout-run-text", { hasText: "Důkaz 2" }),
      ).toBeVisible({ timeout: 20_000 });

      const secondFinalizeResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/desktop-edit-sessions/") &&
          response.url().endsWith("/finalize"),
        { timeout: 45_000 },
      );
      await finishEditingButton.click();
      expect((await secondFinalizeResponse).ok()).toBe(true);
      await expect(finishEditingButton).toBeHidden();
      const finalDocument = await waitForDocumentContaining(
        request,
        testWorkspace.id,
        pleadingUpload.entityId,
        testWorkspace.filePropertyId,
        "Důkaz 2",
      );
      expect(finalDocument).toContain("Důkaz 1");
      expect(finalDocument).toContain("Důkaz 2");
    });
  });
}
