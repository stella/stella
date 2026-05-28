import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { apiUploadDocx } from "../helpers/api";
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
    const entity = await request
      .get(
        `${process.env["E2E_API_URL"] ?? "http://localhost:3001"}/v1/entities/${workspace.id}/entity/${uploaded.entityId}`,
      )
      .then(async (r) => {
        expect(r.ok(), `read entity: ${String(r.status())}`).toBeTruthy();
        return (await r.json()) as {
          fields: {
            id: string;
            propertyId: string;
            content: { type: string };
          }[];
        };
      });

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
    // open. We can't assert on a specific viewer DOM node yet — the inner
    // chrome rewrites often — so the regression we catch here is "the
    // document route loads and doesn't crash on a valid DOCX entity."
    await expect(page).toHaveURL(
      new RegExp(
        `/workspaces/${workspace.id}/${workspace.viewId}/document(\\?|$)`,
        "u",
      ),
    );

    // Give the route a beat to do its initial lazy imports and surface
    // any synchronous render errors. 2s is a heuristic; if it gets flaky,
    // replace with a positive assertion against a stable viewer element.
    await page.waitForTimeout(2000);

    expect(errors, errors.join("\n\n")).toEqual([]);
  });
});
