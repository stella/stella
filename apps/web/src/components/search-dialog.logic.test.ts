import { describe, expect, test } from "bun:test";

import type { GlobalSearchHit } from "@stll/api/types";

import {
  createDialogCloseActionQueue,
  getChatHitRoute,
  getRecentFilePreviewDateVisibility,
  getRecentFilePreviewHit,
} from "./search-dialog.logic";

type ChatGlobalSearchHit = Extract<GlobalSearchHit, { type: "chat" }>;

const chatHit = (
  overrides: Pick<ChatGlobalSearchHit, "threadId" | "workspaceId">,
): ChatGlobalSearchHit => ({
  id: `chat:${overrides.threadId}`,
  type: "chat",
  title: "Review privilege memo",
  headline: null,
  updatedAt: "2026-06-06T10:00:00.000Z",
  threadId: overrides.threadId,
  workspaceId: overrides.workspaceId,
  workspaceName: overrides.workspaceId ? "Matter Alpha" : null,
});

describe("search chat result routing", () => {
  test("opens global chat hits on the global chat route", () => {
    expect(
      getChatHitRoute(
        chatHit({ threadId: "thread-global", workspaceId: null }),
      ),
    ).toEqual({
      to: "/chat/$threadId",
      params: { threadId: "thread-global" },
    });
  });

  test("opens workspace chat hits on the workspace-scoped chat route", () => {
    expect(
      getChatHitRoute(
        chatHit({ threadId: "thread-workspace", workspaceId: "workspace-1" }),
      ),
    ).toEqual({
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: { workspaceId: "workspace-1", threadId: "thread-workspace" },
    });
  });
});

describe("search dialog close actions", () => {
  test("runs a queued route action once, only after close completes", () => {
    const queue = createDialogCloseActionQueue();
    let runCount = 0;

    queue.schedule(() => {
      runCount += 1;
    });

    expect(runCount).toBe(0);
    queue.complete(false);
    expect(runCount).toBe(1);
    queue.complete(false);
    expect(runCount).toBe(1);
  });

  test("discards a queued route action if the dialog reopens", () => {
    const queue = createDialogCloseActionQueue();
    let runCount = 0;

    queue.schedule(() => {
      runCount += 1;
    });
    queue.complete(true);
    queue.complete(false);

    expect(runCount).toBe(0);
  });
});

describe("recent file previews", () => {
  test("reuses stored file metadata as a native document search hit", () => {
    expect(
      getRecentFilePreviewHit({
        entityId: "entity-1",
        fileFieldId: "field-1",
        mimeType: "application/pdf",
        openedAt: "2026-07-31T05:00:00.000Z",
        title: "Disclosure.pdf",
        updatedAt: "2021-03-15T10:00:00.000Z",
        workspaceId: "workspace-1",
        workspaceName: "Disclosure review",
      }),
    ).toEqual({
      entityId: "entity-1",
      fileFieldId: "field-1",
      headline: null,
      id: "document:entity-1",
      lastEditedByImage: null,
      lastEditedByName: null,
      mimeType: "application/pdf",
      title: "Disclosure.pdf",
      type: "document",
      updatedAt: "2021-03-15T10:00:00.000Z",
      workspaceId: "workspace-1",
      workspaceName: "Disclosure review",
    });
  });

  test("omits dates for legacy recents that only store the open timestamp", () => {
    expect(
      getRecentFilePreviewDateVisibility({
        entityId: "entity-1",
        openedAt: "2026-07-31T05:00:00.000Z",
        title: "Disclosure.pdf",
        workspaceId: "workspace-1",
        workspaceName: "Disclosure review",
      }),
    ).toBe("hide");
  });

  test("shows the persisted document update timestamp", () => {
    expect(
      getRecentFilePreviewDateVisibility({
        entityId: "entity-1",
        openedAt: "2026-07-31T05:00:00.000Z",
        title: "Disclosure.pdf",
        updatedAt: "2021-03-15T10:00:00.000Z",
        workspaceId: "workspace-1",
        workspaceName: "Disclosure review",
      }),
    ).toBe("show");
  });
});
