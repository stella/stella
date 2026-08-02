import { randomUUID } from "node:crypto";

import { createUploadedDocumentRoute } from "../helpers/document";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const EXPECTS_DEV_ROUTES = process.env["E2E_EXPECT_DEV_ROUTES"] !== "false";

test.describe("Vite dependency optimizer canary", () => {
  let workspace: TestWorkspace | null = null;

  test.skip(
    !EXPECTS_DEV_ROUTES,
    "This optimizer canary applies only to the Vite development server",
  );

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "vite-canary");
  });

  test.afterEach(async ({ request }) => {
    if (workspace === null) {
      return;
    }

    await deleteTestWorkspace(request, workspace.id);
    workspace = null;
  });

  test("cold lazy dependency graphs settle without restarting Vite", async ({
    page,
    request,
  }) => {
    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const documentRoute = await createUploadedDocumentRoute({
      fileName: "vite-canary.docx",
      request,
      workspace: testWorkspace,
    });

    await page.goto("/chat", { waitUntil: "commit" });
    await expect(
      page.getByRole("textbox", { name: /type your question/iu }),
    ).toBeVisible({ timeout: 30_000 });

    // The thread route is a separate lazy chunk. A missing record is valid for
    // this dependency check; the route deliberately supports an empty thread.
    await page.goto(`/chat/${randomUUID()}`, { waitUntil: "commit" });
    await expect(page.getByRole("log")).toBeVisible({ timeout: 30_000 });

    // A direct document route mounts the Folio editor and file-chat overlay
    // without repeating the production suite's table-navigation journey.
    await page.goto(documentRoute.path, { waitUntil: "commit" });
    await expect(
      page.getByRole("toolbar", { name: "AI message composer" }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(
      page.locator(".layout-run-text", {
        hasText: "Stella E2E test document.",
      }),
    ).toBeVisible({ timeout: 45_000 });

    await page.goto("/dev/autocomplete", { waitUntil: "commit" });
    await expect(
      page.getByRole("heading", {
        name: "stella autocomplete — dev playground",
      }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
