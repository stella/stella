import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { createUploadedDocumentRoute } from "../helpers/document";
import { EXPECTS_DEV_RUNTIME } from "../helpers/runtime-mode";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const ROUTE_READY_TIMEOUT_MS = 60_000;
const ROUTE_COUNT = 4;
const TEST_OVERHEAD_MS = 30_000;

test.describe("Vite dependency optimizer canary", () => {
  let workspace: TestWorkspace | null = null;

  test.setTimeout(TEST_OVERHEAD_MS + ROUTE_COUNT * ROUTE_READY_TIMEOUT_MS);

  test.skip(
    !EXPECTS_DEV_RUNTIME,
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
    browserErrors,
    context,
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

    const [threadPage, documentPage, autocompletePage] = await Promise.all([
      context.newPage(),
      context.newPage(),
      context.newPage(),
    ]);
    const extraPages = [threadPage, documentPage, autocompletePage];
    const detachErrorCollectors = extraPages.map((extraPage) =>
      browserErrors.trackPage(extraPage),
    );

    try {
      // Compile one cold graph at a time. Parallel compilation makes CPU
      // contention indistinguishable from the optimizer restarts this canary
      // detects; the post-test log guard still catches any restart.
      await mountChatIndex(page);
      await mountChatThread(threadPage);
      await mountDocumentRoute(documentPage, documentRoute.path);
      await mountAutocomplete(autocompletePage);
    } finally {
      await Promise.all(extraPages.map(async (extraPage) => extraPage.close()));
      for (const detach of detachErrorCollectors) {
        detach();
      }
    }
  });
});

const mountChatIndex = async (page: Page): Promise<void> => {
  await page.goto("/chat", { waitUntil: "commit" });
  await expect(
    page.getByRole("textbox", { name: /type your question/iu }),
  ).toBeVisible({ timeout: ROUTE_READY_TIMEOUT_MS });
};

const mountChatThread = async (page: Page): Promise<void> => {
  // The thread route is a separate lazy chunk. A missing record is valid for
  // this dependency check; the route deliberately supports an empty thread.
  await page.goto(`/chat/${randomUUID()}`, { waitUntil: "commit" });
  await expect(page.getByRole("log")).toBeVisible({
    timeout: ROUTE_READY_TIMEOUT_MS,
  });
};

const mountDocumentRoute = async (page: Page, route: string): Promise<void> => {
  // A direct document route mounts the Folio editor and file-chat overlay
  // without repeating the production suite's table-navigation journey.
  await page.goto(route, { waitUntil: "commit" });
  await expect(
    page.getByRole("toolbar", { name: "AI message composer" }),
  ).toBeVisible({ timeout: ROUTE_READY_TIMEOUT_MS });
  await expect(
    page.locator(".layout-run-text", {
      hasText: "Stella E2E test document.",
    }),
  ).toBeVisible({ timeout: ROUTE_READY_TIMEOUT_MS });
};

const mountAutocomplete = async (page: Page): Promise<void> => {
  await page.goto("/dev/autocomplete", { waitUntil: "commit" });
  await expect(
    page.getByRole("heading", {
      name: "stella autocomplete — dev playground",
    }),
  ).toBeVisible({ timeout: ROUTE_READY_TIMEOUT_MS });
};
