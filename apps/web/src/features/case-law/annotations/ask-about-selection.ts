import { decisionPassageContent } from "@/components/chat-decision-passage";
import type { DecisionPassage } from "@/components/chat-decision-passage";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  createChatDraftState,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { createChatThreadId, getChatThreadKey } from "@/lib/chat-thread-ref";

/**
 * Opens a fresh inspector chat on the decision with the selected passage
 * already in the composer as a chip, followed by the decision's reference
 * chip and the cursor, so the reader types the question and sends. The
 * decision is attached as the chat's active decision as well, which is
 * what the corpus tools read it by.
 */
export const askAboutSelection = (passage: DecisionPassage): void => {
  const threadId = createChatThreadId();
  useChatDraftStore.getState().setDraft(
    getChatThreadKey({ scope: "global", threadId }),
    createChatDraftState({
      doc: {
        type: "doc",
        content: [
          { type: "paragraph", content: decisionPassageContent(passage) },
        ],
      },
    }),
  );
  useInspectorTabsStore.getState().openChat({
    activeDecisionId: passage.decisionId,
    id: threadId,
    label: passage.caseNumber,
  });
};
