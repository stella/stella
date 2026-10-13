import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { decisionChatKey } from "@/features/chat/legal-document-chat-key";
import {
  lookupLegalDocumentChatThread,
  useLegalDocumentChatThreads,
} from "@/features/chat/legal-document-chat-threads";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

import { openDecisionConversation } from "./decision-chat-open.logic";

const decisionId = toSafeId<"caseLawDecision">(
  "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
);
const serverThread = toChatThreadId("0b1c2d3e-4f50-4a6b-8c7d-000000000001");

const resetStores = (minimized: boolean) => {
  useLegalDocumentChatThreads.setState({ threadIdByDocumentKey: {} });
  useInspectorTabsStore.setState({
    tabs: [],
    groups: [],
    groupAssignments: {},
    collapsedGroupIds: [],
    activeId: null,
    minimized,
    reviveSuggestion: null,
  });
};

// Folded, so the tests see the pane left as the reader had it.
beforeEach(() => {
  resetStores(true);
});

// The stores are process-wide: hand the next file the defaults.
afterEach(() => {
  resetStores(false);
});

const chatTabs = () =>
  useInspectorTabsStore.getState().tabs.filter((tab) => tab.type === "chat");

describe("opening a decision's conversation", () => {
  test("continues the reader's conversation the server found", () => {
    openDecisionConversation({ decisionId, threadId: serverThread });

    expect(chatTabs()).toEqual([
      expect.objectContaining({
        id: serverThread,
        activeLegalKey: decisionChatKey(decisionId),
        started: true,
      }),
    ]);
    expect(lookupLegalDocumentChatThread(decisionChatKey(decisionId))).toEqual({
      status: "thread",
      threadId: serverThread,
    });
    // The pane stays as the reader left it.
    expect(useInspectorTabsStore.getState().minimized).toBe(true);
  });

  test("turns a chat already minted for the decision into that conversation", () => {
    useInspectorTabsStore
      .getState()
      .openChat({ activeLegalKey: decisionChatKey(decisionId) });
    const minted = chatTabs().at(0)?.id;
    expect(minted).not.toBe(serverThread);

    openDecisionConversation({ decisionId, threadId: serverThread });

    // One tab, now the server's conversation: never a second beside it.
    expect(chatTabs().map((tab) => tab.id)).toEqual([serverThread]);
  });

  test("with no conversation yet, opens a fresh chat that has not started", () => {
    openDecisionConversation({ decisionId, threadId: null });

    const tabs = chatTabs();
    expect(tabs).toHaveLength(1);
    const tab = tabs.at(0);
    expect(tab?.type === "chat" ? tab.started : "not a chat").toBeUndefined();
  });
});
