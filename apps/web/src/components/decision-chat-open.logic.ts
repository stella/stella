import { INSPECTOR_PANE_INTENT } from "@/components/inspector/inspector-store-types";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { decisionChatKey } from "@/features/chat/legal-document-chat-key";
import type { ChatThreadId } from "@/lib/chat-thread-ref";
import type { SafeId } from "@/lib/safe-id";

/**
 * Puts a decision's conversation on the inspector rail. A decision's chat is
 * one conversation per reader, and the server knows which: when the reader
 * already has one, that thread is the tab, whatever this window or a restored
 * tab set had minted for the decision before the answer came; otherwise the
 * tab is a fresh chat that becomes the conversation on its first message.
 * The pane belongs to the reader, so the rail is seeded and the pane kept.
 */
export const openDecisionConversation = ({
  decisionId,
  threadId,
}: {
  decisionId: SafeId<"caseLawDecision">;
  /** The reader's conversation about the decision, or null for none yet. */
  threadId: ChatThreadId | null;
}): void => {
  const store = useInspectorTabsStore.getState();
  const activeLegalKey = decisionChatKey(decisionId);
  if (threadId === null) {
    store.openChat({ activeLegalKey, pane: INSPECTOR_PANE_INTENT.keep });
    return;
  }
  // A tab this decision already has becomes the conversation, rather than a
  // second tab beside it.
  const bound = store.tabs.find(
    (tab) => tab.type === "chat" && tab.activeLegalKey === activeLegalKey,
  );
  if (
    bound?.type === "chat" &&
    bound.id !== threadId &&
    !store.tabs.some((tab) => tab.id === threadId)
  ) {
    store.resetChatTabId(bound.id, threadId);
  }
  store.openChat({
    activeLegalKey,
    id: threadId,
    pane: INSPECTOR_PANE_INTENT.keep,
    started: true,
  });
};
