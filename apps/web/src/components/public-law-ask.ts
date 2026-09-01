import { createChatComposerDocument } from "@/components/chat-editor-markdown.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  createChatDraftState,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { createChatThreadId, getChatThreadKey } from "@/lib/chat-thread-ref";

type OpenPublicLawChatOptions = {
  label: string;
  prompt: string;
};

/**
 * Opens a fresh inspector chat with the prompt already in the composer. The
 * reader sends it, so the question can be edited before it costs a request.
 * The chat is global: the public reader has no matter to scope it to.
 */
export const openPublicLawChat = ({
  label,
  prompt,
}: OpenPublicLawChatOptions): void => {
  const threadId = createChatThreadId();
  useChatDraftStore
    .getState()
    .setDraft(
      getChatThreadKey({ scope: "global", threadId }),
      createChatDraftState({ doc: createChatComposerDocument(prompt) }),
    );
  useInspectorTabsStore.getState().openChat({ id: threadId, label });
};
