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

type EntityFileField = {
  id: string;
  propertyId: string;
  content: { type: string };
};

type EntityWithFields = {
  fields: EntityFileField[];
};

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

const readDocumentXml = async (docxBuffer: Buffer) => {
  const zip = await JSZip.loadAsync(docxBuffer);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (documentXml === undefined) {
    throw new Error("Saved DOCX is missing word/document.xml");
  }
  return documentXml;
};

test.describe("DOCX upload + inspector", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "upload-docx");
  });

  test.afterEach(async ({ request }) => {
    if (workspace === null) {
      return;
    }

    await deleteTestWorkspace(request, workspace.id);
    workspace = null;
  });

  test("uploaded DOCX renders in the document view", async ({
    browserErrors,
    page,
    request,
  }) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const docxBuffer = await readFile(DOCX_PATH);

    const uploaded = await apiUploadDocx(
      request,
      testWorkspace.id,
      testWorkspace.filePropertyId,
      {
        name: "stella-e2e.docx",
        mimeType: DOCX_MIME,
        buffer: docxBuffer,
      },
    );
    expect(uploaded.entityId).toBeTruthy();

    // The document view requires both entity + field URL params (see
    // apps/web/src/routes/_protected.workspaces/$workspaceId/$viewId.document.tsx:198).
    // Read the entity to find the file field id.
    const entity = await readEntity(
      request,
      testWorkspace.id,
      uploaded.entityId,
    );
    const fileField = findFileFieldForProperty(
      entity,
      testWorkspace.filePropertyId,
    );
    expect(fileField, "uploaded file field present on entity").toBeTruthy();

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

    // Do not wait for the full load event here; the assertions below prove
    // the route and viewer finished the work that matters for this test.
    await page.goto(
      `/workspaces/${testWorkspace.id}/${testWorkspace.viewId}/document?entity=${uploaded.entityId}&field=${fileField!.id}`,
      { waitUntil: "domcontentloaded" },
    );

    // The route stays mounted (didn't redirect to /auth or the workspace
    // index). toHaveURL retries until it matches the timeout, so we don't
    // have to fight networkidle on a page that keeps long-poll/SSE sockets
    // open.
    await expect(page).toHaveURL(
      new RegExp(
        `/workspaces/${testWorkspace.id}/${testWorkspace.viewId}/document(\\?|$)`,
        "u",
      ),
    );

    // Positive proof the viewer actually rendered: the fixture's first
    // paragraph appears in the painted layout. This catches render crashes
    // (an error boundary fallback wouldn't contain this string) without an
    // arbitrary sleep. Generous timeout because in CI the Folio chunk
    // compiles + loads cold AND the DOCX file is fetched from the API +
    // parsed.
    //
    // Scope to `.layout-run-text` (emitted by the layout painter in
    // packages/folio/src/core/layout-painter/renderParagraph.ts) rather
    // than getByText so the assertion targets the *visible* painted span
    // only. The hidden ProseMirror at left:-9999px also contains the same
    // text inside a <p> under aria-label="Document content" — a bare
    // getByText hits both elements and trips Playwright strict mode.
    const docxText = page.locator(".layout-run-text", {
      hasText: "Stella E2E test document.",
    });
    try {
      await expect(docxText).toBeVisible({ timeout: 45_000 });
    } catch (error) {
      // Surface any errors collected so far — they're usually the real cause
      // of the viewer never mounting (network failure, render crash caught
      // by an error boundary, etc.).
      const errors = browserErrors.entries();
      if (errors.length > 0) {
        throw new Error(
          `viewer text never appeared; collected errors:\n${errors.join("\n\n")}`,
          { cause: error },
        );
      }
      throw error;
    }
  });

  test("browser edit save creates a persisted DOCX version with the typed text", async ({
    page,
    request,
  }) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const docxBuffer = await readFile(DOCX_PATH);
    const uploaded = await apiUploadDocx(
      request,
      testWorkspace.id,
      testWorkspace.filePropertyId,
      {
        name: "stella-e2e-edit.docx",
        mimeType: DOCX_MIME,
        buffer: docxBuffer,
      },
    );

    const originalEntity = await readEntity(
      request,
      testWorkspace.id,
      uploaded.entityId,
    );
    const originalFileField = findFileFieldForProperty(
      originalEntity,
      testWorkspace.filePropertyId,
    );
    expect(
      originalFileField,
      "uploaded file field present on entity",
    ).toBeTruthy();

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

    const editToken = `E2ESAVETOKEN${String(Date.now())}`;
    await page.goto(
      `/workspaces/${testWorkspace.id}/${testWorkspace.viewId}/document` +
        `?entity=${uploaded.entityId}&field=${originalFileField!.id}&editing=true`,
      { waitUntil: "domcontentloaded" },
    );

    const finishEditingButton = page.getByRole("button", {
      name: "Finish editing",
    });
    await expect(finishEditingButton).toBeEnabled({ timeout: 45_000 });

    const firstParagraphText = page.locator(".layout-run-text", {
      hasText: "Stella E2E test document.",
    });
    await expect(firstParagraphText).toBeVisible({ timeout: 45_000 });

    await firstParagraphText.click();
    await page.keyboard.type(editToken);
    await expect(
      page.locator(".layout-run-text", { hasText: editToken }),
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

    await expect
      .poll(
        async () => {
          const entity = await readEntity(
            request,
            testWorkspace.id,
            uploaded.entityId,
          );
          const fileField = findFileFieldForProperty(
            entity,
            testWorkspace.filePropertyId,
          );
          return fileField?.id !== originalFileField!.id ? fileField?.id : null;
        },
        {
          message: "saved DOCX version appears on the entity",
          timeout: 30_000,
        },
      )
      .not.toBeNull();

    const latestEntity = await readEntity(
      request,
      testWorkspace.id,
      uploaded.entityId,
    );
    const latestFileField = findFileFieldForProperty(
      latestEntity,
      testWorkspace.filePropertyId,
    );
    expect(latestFileField, "saved file field present on entity").toBeTruthy();

    const savedBuffer = await apiDownloadFileField(
      request,
      testWorkspace.id,
      latestFileField!.id,
    );
    const documentXml = await readDocumentXml(savedBuffer);
    expect(documentXml).toContain(editToken);
  });
});
