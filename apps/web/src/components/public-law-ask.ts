import { activeLegalDocumentRef } from "@/components/ai-suggestions/active-legal-document";
import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { createChatComposerDocument } from "@/components/chat-editor-markdown.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { ensureLegalDocumentChatThread } from "@/features/chat/legal-document-chat-threads";
import {
  createChatDraftState,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { createChatThreadId, getChatThreadKey } from "@/lib/chat-thread-ref";

type OpenPublicLawChatOptions = {
  /**
   * The document the question is about, when it has one. That document owns a
   * single conversation, so the prompt joins it rather than opening a rival
   * thread beside the composer already floating over the same text. Absent
   * where the question is about a search rather than a document on screen.
   */
  document?: ActiveLegalDocument | undefined;
  label: string;
  prompt: string;
};

/**
 * Opens an inspector chat with the prompt already in the composer. The reader
 * sends it, so the question can be edited before it costs a request. The chat
 * is global: the public reader has no matter to scope it to.
 *
 * The draft this writes replaces whatever was unsent in that composer: losing
 * a half-typed line is the lesser harm against asking the question away from
 * the history it belongs to.
 */
export const openPublicLawChat = ({
  document,
  label,
  prompt,
}: OpenPublicLawChatOptions): void => {
  const documentKey =
    document === undefined ? undefined : activeLegalDocumentRef(document).key;
  const threadId =
    documentKey === undefined
      ? createChatThreadId()
      : ensureLegalDocumentChatThread({ documentKey });
  useChatDraftStore
    .getState()
    .setDraft(
      getChatThreadKey({ scope: "global", threadId }),
      createChatDraftState({ doc: createChatComposerDocument(prompt) }),
    );
  useInspectorTabsStore.getState().openChat({
    id: threadId,
    label,
    ...(documentKey === undefined ? {} : { activeLegalKey: documentKey }),
  });
};
