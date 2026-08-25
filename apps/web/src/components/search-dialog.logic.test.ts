import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE, toResourceName } from "@stll/api-contract";
import type { GlobalSearchHit } from "@stll/api/types";

import { toSafeId } from "@/lib/safe-id";

import {
  canUseAskAIShortcut,
  createDialogCloseActionQueue,
  getChatHitRoute,
  getEntityLocationRoute,
  getEntityWorkspaceRoute,
  getRecentFileRoute,
  getRecentFilePreviewDateVisibility,
  getRecentFilePreviewHit,
  rememberSelectedFacetLabels,
  resolveEntityDocumentRoute,
  toAskAIMessageHtml,
} from "./search-dialog.logic";

type ChatGlobalSearchHit = Extract<GlobalSearchHit, { type: "chat" }>;

const chatHit = (
  overrides: Pick<ChatGlobalSearchHit, "threadId" | "workspaceId">,
): ChatGlobalSearchHit => {
  const resource = resourceRef({
    type: RESOURCE_TYPE.CHAT_THREAD,
    id: toSafeId<"chatThread">(overrides.threadId),
  });

  return {
    id: `chat:${overrides.threadId}`,
    type: "chat",
    resource,
    resourceName: toResourceName(resource),
    title: "Review privilege memo",
    headline: null,
    updatedAt: "2026-06-06T10:00:00.000Z",
    threadId: overrides.threadId,
    workspaceId: overrides.workspaceId,
    workspaceName: overrides.workspaceId ? "Matter Alpha" : null,
  };
};

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

describe("search facet labels", () => {
  test("retains a controlled selection label after later results omit it", () => {
    const selected = ["user-1"];
    const resolved = rememberSelectedFacetLabels(
      {},
      selected,
      new Map([["user-1", "Ada Lovelace"]]),
    );

    expect(rememberSelectedFacetLabels(resolved, selected, new Map())).toEqual({
      "user-1": "Ada Lovelace",
    });
  });
});

describe("document routes", () => {
  test("re-resolves a live search file immediately before navigation", async () => {
    expect(
      await resolveEntityDocumentRoute({
        hit: {
          entityId: "entity-1",
          fileFieldId: "stale-field",
          workspaceId: "workspace-1",
        },
        resolveCurrentFileFieldId: async () => "current-field",
      }),
    ).toEqual({
      fileFieldId: "current-field",
      route: {
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId: "workspace-1", viewId: "all" },
        search: { entity: "entity-1", field: "current-field" },
      },
    });
  });

  test("opens the all view when current resolution finds no file field", async () => {
    expect(
      await resolveEntityDocumentRoute({
        hit: {
          entityId: "entity-1",
          fileFieldId: "stale-field",
          workspaceId: "workspace-1",
        },
        resolveCurrentFileFieldId: async () => null,
      }),
    ).toEqual({
      fileFieldId: null,
      route: {
        to: "/workspaces/$workspaceId/$viewId",
        params: { workspaceId: "workspace-1", viewId: "all" },
      },
    });
  });

  test("routes non-document entity hits to the all view", () => {
    expect(getEntityWorkspaceRoute({ workspaceId: "workspace-1" })).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { workspaceId: "workspace-1", viewId: "all" },
    });
  });

  test("opens the containing folder for a modifier-activated entity hit", () => {
    const documentHit = getRecentFilePreviewHit({
      entityId: "entity-1",
      openedAt: "2026-07-31T05:00:00.000Z",
      title: "Disclosure.pdf",
      workspaceId: "workspace-1",
      workspaceName: "Disclosure review",
    });

    expect(
      getEntityLocationRoute({ ...documentHit, parentId: "folder-1" }),
    ).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { workspaceId: "workspace-1", viewId: "all" },
      search: { folder: "folder-1" },
    });
    // Matter-root entities carry no folder scope.
    expect(getEntityLocationRoute(documentHit)).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { workspaceId: "workspace-1", viewId: "all" },
    });
    // Hits without a containing matter location keep their normal open.
    expect(
      getEntityLocationRoute(
        chatHit({ threadId: "thread-1", workspaceId: null }),
      ),
    ).toBeNull();
  });

  test("opens a recent file directly when its field id was persisted", () => {
    expect(
      getRecentFileRoute({
        entityId: "entity-1",
        fileFieldId: "field-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      to: "/workspaces/$workspaceId/$viewId/document",
      params: { workspaceId: "workspace-1", viewId: "all" },
      search: { entity: "entity-1", field: "field-1" },
    });
  });

  test("opens the all view for a recent file without a field id", () => {
    expect(
      getRecentFileRoute({
        entityId: "entity-1",
        fileFieldId: null,
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      to: "/workspaces/$workspaceId/$viewId",
      params: { workspaceId: "workspace-1", viewId: "all" },
    });
  });
});

describe("recent file previews", () => {
  test("reuses stored file metadata as a native document search hit", () => {
    const resource = resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">("entity-1"),
    });
    expect(
      getRecentFilePreviewHit({
        entityId: "entity-1",
        fileFieldId: "field-1",
        filePropertyId: "property-1",
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
      filePropertyId: "property-1",
      headline: null,
      id: "document:entity-1",
      lastEditedByImage: null,
      lastEditedByName: null,
      mimeType: "application/pdf",
      parentId: null,
      resource,
      resourceName: toResourceName(resource),
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

describe("toAskAIMessageHtml", () => {
  test("escapes markup-significant characters so the query stays literal text", () => {
    const query = "liability cap < 5% & indemnity <b>scope</b>";
    expect(toAskAIMessageHtml(query)).not.toBe(query);
    expect(toAskAIMessageHtml(query)).toBe(
      "liability cap &lt; 5% &amp; indemnity &lt;b&gt;scope&lt;/b&gt;",
    );
  });

  test("leaves plain queries untouched", () => {
    expect(toAskAIMessageHtml("smluvní pokuta")).toBe("smluvní pokuta");
  });
});

describe("Ask AI keyboard shortcut", () => {
  test("is available only while browsing", () => {
    expect(
      canUseAskAIShortcut({
        canAskAI: true,
        mode: "browse",
        query: "indemnity",
      }),
    ).toBe(true);
    expect(
      canUseAskAIShortcut({
        canAskAI: true,
        mode: "pick",
        query: "indemnity",
      }),
    ).toBe(false);
  });
});
