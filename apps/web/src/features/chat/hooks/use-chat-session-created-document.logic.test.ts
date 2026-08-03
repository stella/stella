import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  buildCreateDocumentDraftPayload,
  CREATE_DOCUMENT_DRAFT_VIEW,
  createDocumentDraftTabId,
} from "@/components/chat/create-document-draft.logic";
import type {
  InspectorTab,
  InspectorTabsStore,
} from "@/components/inspector/inspector-store-types";
import { toChatThreadId } from "@/lib/chat-thread-ref";

import {
  invalidateCreatedDocumentQueries,
  promoteCreateDocumentDraftInspectorTab,
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
        inspector,
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
        inspector,
        toolCallId: "tool-1",
        workspaceId: "workspace-1",
      }),
    ).toBe(false);
  });
});
