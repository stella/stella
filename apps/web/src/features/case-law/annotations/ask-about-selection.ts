import { createChatComposerDocument } from "@/components/chat-editor-markdown.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  createChatDraftState,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { createChatThreadId, getChatThreadKey } from "@/lib/chat-thread-ref";

type AskAboutSelectionOptions = {
  caseNumber: string;
  court: string;
  decisionId: string;
  /** Absolute address of the decision, so the model can name and reopen it. */
  decisionUrl: string;
  quote: string;
};

/** The passage as the composer shows it: quoted, then its source. */
export const selectionPrompt = ({
  caseNumber,
  court,
  decisionUrl,
  quote,
}: Omit<AskAboutSelectionOptions, "decisionId">): string =>
  `„${quote.replace(/\s+/gu, " ").trim()}“\n— ${caseNumber}, ${court}\n${decisionUrl}\n\n`;

/**
 * Opens a fresh inspector chat on the decision with the selected passage
 * already in the composer, cursor after it, so the reader types the
 * question and sends. The decision is attached as the chat's active
 * decision as well, which is what the corpus tools read it by.
 */
export const askAboutSelection = ({
  decisionId,
  ...prompt
}: AskAboutSelectionOptions): void => {
  const threadId = createChatThreadId();
  useChatDraftStore.getState().setDraft(
    getChatThreadKey({ scope: "global", threadId }),
    createChatDraftState({
      doc: createChatComposerDocument(selectionPrompt(prompt)),
    }),
  );
  useInspectorTabsStore.getState().openChat({
    activeDecisionId: decisionId,
    id: threadId,
    label: prompt.caseNumber,
  });
};
