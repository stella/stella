import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiGet, apiStatus, apiUploadDocx } from "../helpers/api";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");

// Transport-layer connection drops the browser reports as console errors.
// These are dev-server infra flakes, not app errors: the document route
// fires a burst of API requests after a multi-second gap (cold Folio chunk
// compile + DOCX parse), and the Bun dev server occasionally tears down an
// idle HTTP/1.1 keep-alive socket at the instant the browser reuses it, so a
// single request fails with net::ERR_EMPTY_RESPONSE (React Query retries it;
// the viewer still paints). They originate in the network stack, never an
// error boundary, so they cannot be the render-loop bug the console guard
// protects against — unlike an HTTP 4xx/5xx, which still arrives as a
// response and is kept. Match only dropped-connection codes, not the broader
// "failed to load resource" family.
const TRANSIENT_NETWORK_ERROR =
  /net::(?:ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_NETWORK_CHANGED)/u;

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
    page,
    request,
  }) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const docxBuffer = await readFile(DOCX_PATH);

    // Catch ANY error — uncaught exceptions AND console.error. Render-loop
    // bugs (React #185 / "Maximum update depth") only reach console.error
    // because they're caught by error boundaries; ignoring them would let
    // a viewer-crash regression slip through. If new noise appears here,
    // fix the noise — don't broaden the filter. The one carve-out is
    // TRANSIENT_NETWORK_ERROR (dropped-connection transport flakes, which
    // cannot be a render bug); see its definition above.
    const errors: string[] = [];
    page.on("pageerror", (err) => {
      errors.push(`pageerror: ${err.message}`);
    });
    page.on("console", (msg) => {
      if (msg.type() !== "error") {
        return;
      }
      const text = msg.text();
      if (TRANSIENT_NETWORK_ERROR.test(text)) {
        return;
      }
      errors.push(`console.error: ${text}`);
    });

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
    const entity = await apiGet<{
      fields: {
        id: string;
        propertyId: string;
        content: { type: string };
      }[];
    }>(request, `/entities/${testWorkspace.id}/entity/${uploaded.entityId}`);

    const fileField = entity.fields.find(
      (f) =>
        f.propertyId === testWorkspace.filePropertyId &&
        f.content.type === "file",
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
