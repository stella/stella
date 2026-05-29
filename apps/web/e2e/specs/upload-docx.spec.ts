import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { apiGet, apiUploadDocx } from "../helpers/api";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = resolve(import.meta.dirname, "../fixtures/simple.docx");

test.describe("DOCX upload + inspector", () => {
  let workspace: TestWorkspace;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "upload-docx");
  });

  test.afterEach(async ({ request }) => {
    await deleteTestWorkspace(request, workspace.id);
  });

  test("uploaded DOCX renders in the document view", async ({
    page,
    request,
  }) => {
    const docxBuffer = await readFile(DOCX_PATH);

    // Catch ANY error — uncaught exceptions AND console.error. Render-loop
    // bugs (React #185 / "Maximum update depth") only reach console.error
    // because they're caught by error boundaries; ignoring them would let
    // a viewer-crash regression slip through. If new noise appears here,
    // fix the noise — don't broaden the filter.
    const errors: string[] = [];
    page.on("pageerror", (err) => {
      errors.push(`pageerror: ${err.message}`);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(`console.error: ${msg.text()}`);
      }
    });

    const uploaded = await apiUploadDocx(
      request,
      workspace.id,
      workspace.filePropertyId,
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
    const entity = await apiGet<{
      fields: {
        id: string;
        propertyId: string;
        content: { type: string };
      }[];
    }>(request, `/entities/${workspace.id}/entity/${uploaded.entityId}`);

    const fileField = entity.fields.find(
      (f) =>
        f.propertyId === workspace.filePropertyId && f.content.type === "file",
    );
    expect(fileField, "uploaded file field present on entity").toBeTruthy();

    await page.goto(
      `/workspaces/${workspace.id}/${workspace.viewId}/document?entity=${uploaded.entityId}&field=${fileField!.id}`,
    );

    // The route stays mounted (didn't redirect to /auth or the workspace
    // index). toHaveURL retries until it matches the timeout, so we don't
    // have to fight networkidle on a page that keeps long-poll/SSE sockets
    // open.
    await expect(page).toHaveURL(
      new RegExp(
        `/workspaces/${workspace.id}/${workspace.viewId}/document(\\?|$)`,
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
      if (errors.length > 0) {
        throw new Error(
          `viewer text never appeared; collected errors:\n${errors.join("\n\n")}`,
          { cause: error },
        );
      }
      throw error;
    }

    expect(errors, errors.join("\n\n")).toEqual([]);
  });
});
