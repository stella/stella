import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  buildCreateDocumentDraftPayload,
  CREATE_DOCUMENT_DRAFT_VIEW,
  createDocumentDraftTabId,
  isCreateDocumentDraftPayload,
} from "@/components/chat/create-document-draft.logic";
import type {
  InspectorTab,
  InspectorTabsStore,
} from "@/components/inspector/inspector-store-types";
import { toChatThreadId } from "@/lib/chat-thread-ref";

import {
  invalidateCreatedDocumentQueries,
  bindCreateDocumentDraftInspectorChatThread,
  getBoundCreateDocumentDraftInspectorChatThreadId,
  promoteCreateDocumentDraftInspectorTab,
  resolveBoundCreateDocumentDraftChatThreadId,
  setCreateDocumentDraftInspectorChatThreadId,
  setCreateDocumentDraftInspectorTabStatus,
} from "./use-chat-session-created-document.logic";

describe("invalidateCreatedDocumentQueries", () => {
  test("invalidates entity and activity caches only for the target matter", async () => {
    const queryClient = new QueryClient();
    const targetEntityRootKey = ["entities", "matter-a"];
    const targetEntityKey = [...targetEntityRootKey, "list"];
    const otherEntityKey = ["entities", "matter-b", "list"];
    const targetActivityRootKey = ["workspaces", "matter-a", "activity"];
    const targetActivityKey = [...targetActivityRootKey, "organization-a"];
    const otherActivityKey = [
      "workspaces",
      "matter-b",
      "activity",
      "organization-a",
    ];
    for (const key of [
      targetEntityKey,
      otherEntityKey,
      targetActivityKey,
      otherActivityKey,
    ]) {
      queryClient.setQueryData(key, { pages: [] });
    }

    await invalidateCreatedDocumentQueries({
      queryClient,
      queryKeys: [targetEntityRootKey, targetActivityRootKey],
    });

    expect(queryClient.getQueryState(targetEntityKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(targetActivityKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(otherEntityKey)?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryState(otherActivityKey)?.isInvalidated).toBe(
      false,
    );
  });
});

describe("create-document inspector transition", () => {
  test("forwards only a server-bound draft chat for matter persistence", () => {
    const tabs: InspectorTab[] = [
      {
        id: createDocumentDraftTabId("tool-1"),
        label: "Draft.docx",
        payload: buildCreateDocumentDraftPayload({
          draft: {
            messageId: "message-1",
            toolCallId: "tool-1",
            name: "Draft",
            source: "@doc",
            status: "ready",
          },
          existingPayload: undefined,
          originChatThreadId: toChatThreadId("origin-thread"),
        }),
        type: "view",
        viewType: CREATE_DOCUMENT_DRAFT_VIEW,
      },
    ];
    const inspector = {
      tabs,
      updateView: ({ id, label, payload }) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (tab?.type !== "view") {
          return;
        }
        tab.label = label;
        tab.payload = payload;
      },
    } satisfies Pick<InspectorTabsStore, "tabs" | "updateView">;

    expect(
      getBoundCreateDocumentDraftInspectorChatThreadId({
        inspector,
        toolCallId: "tool-1",
      }),
    ).toBeNull();

    const tab = tabs.at(0);
    if (tab?.type !== "view" || !isCreateDocumentDraftPayload(tab.payload)) {
      throw new Error("Expected a generated document draft tab");
    }
    expect(
      bindCreateDocumentDraftInspectorChatThread({
        chatThreadId: tab.payload.chatThreadId,
        inspector,
        toolCallId: "tool-1",
      }),
    ).toBe(true);
    expect(
      getBoundCreateDocumentDraftInspectorChatThreadId({
        inspector,
        toolCallId: "tool-1",
      }),
    ).toBe(tab.payload.chatThreadId);

    inspector.tabs.length = 0;
    expect(
      resolveBoundCreateDocumentDraftChatThreadId({
        inspector,
        retainedChatThreadId: tab.payload.chatThreadId,
        toolCallId: "tool-1",
      }),
    ).toBe(tab.payload.chatThreadId);
  });

  test("locks an open draft during save and restores it after failure", () => {
    const toolCallId = "tool-1";
    const id = createDocumentDraftTabId(toolCallId);
    const tabs: InspectorTab[] = [
      {
        type: "view",
        viewType: CREATE_DOCUMENT_DRAFT_VIEW,
        id,
        label: "Power of attorney.docx",
        payload: buildCreateDocumentDraftPayload({
          draft: {
            messageId: "message-origin",
            toolCallId,
            name: "Power of attorney",
            source: "@doc kind=other locale=en page=A4",
            status: "ready",
          },
          existingPayload: undefined,
          originChatThreadId: toChatThreadId("thread-origin"),
        }),
      },
    ];
    const inspector = {
      tabs,
      updateView: ({ id: updatedId, label, payload }) => {
        const tab = tabs.find((candidate) => candidate.id === updatedId);
        if (tab?.type === "view") {
          tab.label = label;
          tab.payload = payload;
        }
      },
    } satisfies Pick<InspectorTabsStore, "tabs" | "updateView">;

    expect(
      setCreateDocumentDraftInspectorTabStatus({
        inspector,
        status: "saving",
        toolCallId,
      }),
    ).toBe(true);
    const savingTab = tabs.at(0);
    expect(savingTab?.type === "view" ? savingTab.payload : null).toMatchObject(
      { status: "saving" },
    );

    expect(
      setCreateDocumentDraftInspectorTabStatus({
        inspector,
        status: "ready",
        toolCallId,
      }),
    ).toBe(true);
    const restoredTab = tabs.at(0);
    expect(
      restoredTab?.type === "view" ? restoredTab.payload : null,
    ).toMatchObject({ status: "ready" });
  });

  test("promotes the open draft in place without a close/open cycle", () => {
    const toolCallId = "tool-1";
    const id = createDocumentDraftTabId(toolCallId);
    const payload = buildCreateDocumentDraftPayload({
      draft: {
        messageId: "message-origin",
        toolCallId,
        name: "Power of attorney",
        source: "@doc kind=other locale=en page=A4",
        status: "ready",
      },
      existingPayload: undefined,
      originChatThreadId: toChatThreadId("thread-origin"),
    });
    const tabs: InspectorTab[] = [
      {
        type: "view",
        viewType: CREATE_DOCUMENT_DRAFT_VIEW,
        id,
        label: "Power of attorney.docx",
        payload,
      },
    ];
    let updateCount = 0;
    const inspector = {
      tabs,
      updateView: ({ id: updatedId, label, payload: updatedPayload }) => {
        const tab = tabs.find((candidate) => candidate.id === updatedId);
        if (tab?.type !== "view") {
          return;
        }
        updateCount += 1;
        tab.label = label;
        tab.payload = updatedPayload;
      },
    } satisfies Pick<InspectorTabsStore, "tabs" | "updateView">;
    const activeId = id;

    expect(
      promoteCreateDocumentDraftInspectorTab({
        entityId: "entity-1",
        fieldId: "field-1",
        fileName: "Power of attorney.docx",
        getInspector: () => inspector,
        toolCallId,
        workspaceId: "workspace-1",
      }),
    ).toBe(true);

    expect(tabs).toHaveLength(1);
    expect(activeId).toBe(id);
    expect(updateCount).toBe(1);
    expect(tabs.at(0)).toMatchObject({
      id,
      type: "view",
      viewType: CREATE_DOCUMENT_DRAFT_VIEW,
      payload: {
        status: "persisted",
        entityId: "entity-1",
        fieldId: "field-1",
        workspaceId: "workspace-1",
      },
    });

    expect(
      setCreateDocumentDraftInspectorChatThreadId({
        chatThreadId: toChatThreadId("thread-rotated"),
        inspector,
        toolCallId,
      }),
    ).toBe(true);
    expect(updateCount).toBe(2);
    expect(tabs.at(0)).toMatchObject({
      id,
      payload: {
        chatThreadId: "thread-rotated",
        entityId: "entity-1",
        fieldId: "field-1",
        status: "persisted",
      },
    });

    expect(
      setCreateDocumentDraftInspectorChatThreadId({
        chatThreadId: toChatThreadId("thread-origin"),
        inspector,
        toolCallId,
      }),
    ).toBe(false);
    expect(updateCount).toBe(2);
  });

  test("promotes a draft reopened while its save is pending", () => {
    const toolCallId = "tool-1";
    const reopenedTabs: InspectorTab[] = [
      {
        id: createDocumentDraftTabId(toolCallId),
        label: "Power of attorney.docx",
        payload: {
          ...buildCreateDocumentDraftPayload({
            draft: {
              messageId: "message-origin",
              toolCallId,
              name: "Power of attorney",
              source: "@doc kind=other locale=en page=A4",
              status: "ready",
            },
            existingPayload: undefined,
            originChatThreadId: toChatThreadId("thread-origin"),
          }),
          status: "saving",
        },
        type: "view",
        viewType: CREATE_DOCUMENT_DRAFT_VIEW,
      },
    ];
    const closedInspector = {
      tabs: [],
      updateView: () => {},
    } satisfies Pick<InspectorTabsStore, "tabs" | "updateView">;
    const reopenedInspector = {
      tabs: reopenedTabs,
      updateView: ({ id, label, payload }) => {
        const tab = reopenedTabs.find((candidate) => candidate.id === id);
        if (tab?.type !== "view") {
          return;
        }
        tab.label = label;
        tab.payload = payload;
      },
    } satisfies Pick<InspectorTabsStore, "tabs" | "updateView">;
    let currentInspector: Pick<InspectorTabsStore, "tabs" | "updateView"> =
      closedInspector;

    currentInspector = reopenedInspector;
    expect(
      promoteCreateDocumentDraftInspectorTab({
        entityId: "entity-1",
        fieldId: "field-1",
        fileName: "Power of attorney.docx",
        getInspector: () => currentInspector,
        toolCallId,
        workspaceId: "workspace-1",
      }),
    ).toBe(true);
    expect(reopenedTabs.at(0)).toMatchObject({
      payload: { status: "persisted", entityId: "entity-1" },
    });
  });

  test("falls back when the user closed the draft before persistence finishes", () => {
    const inspector = {
      tabs: [],
      updateView: () => {},
    } satisfies Pick<InspectorTabsStore, "tabs" | "updateView">;
    expect(
      promoteCreateDocumentDraftInspectorTab({
        entityId: "entity-1",
        fieldId: "field-1",
        fileName: "Power of attorney.docx",
        getInspector: () => inspector,
        toolCallId: "tool-1",
        workspaceId: "workspace-1",
      }),
    ).toBe(false);
  });
});
