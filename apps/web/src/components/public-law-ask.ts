import type { ChatCorpusScope } from "@stll/api-contract";

import { activeLegalDocumentRef } from "@/components/ai-suggestions/active-legal-document";
import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";
import { createChatComposerDocument } from "@/components/chat-editor-markdown.logic";
import { toChatMentionNodeAttrs } from "@/components/chat-mention-node-attrs";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { ensureLegalDocumentChatThread } from "@/features/chat/legal-document-chat-threads";
import {
  findQueuedChatSend,
  queueChatSend,
} from "@/features/chat/queued-chat-sends";
import {
  createChatDraftState,
  useChatDraftStore,
} from "@/lib/chat-draft-store";
import { createChatThreadId, getChatThreadKey } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

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

type AskPublicLawInChatOptions = {
  /** The tab's title: the question as the reader typed it. */
  label: string;
  question: string;
  /** The corpus the search was in, sent as a chip that scopes the turn. */
  scope: ChatCorpusScope;
  /** The chip's text, already translated ("Case law · Czechia"). */
  scopeLabel: string;
};

/**
 * Asks a search's question in a new inspector chat and sends it at once: the
 * reader pressed "Ask in chat" to get an answer, not a draft to send. The
 * corpus goes in front as a chip, so the server scopes the turn's corpus tools
 * to it rather than reading a jurisdiction out of the wording.
 *
 * The tab sends the message itself when it mounts (`claimQueuedChatSend`),
 * past its own AI check. A second press before then joins the same thread.
 */
export const askPublicLawInChat = ({
  label,
  question,
  scope,
  scopeLabel,
}: AskPublicLawInChatOptions): void => {
  const html = corpusQuestionHtml({ question, scope, scopeLabel });
  const threadRef =
    findQueuedChatSend(html) ??
    (() => {
      const created = {
        scope: "global",
        threadId: createChatThreadId(),
      } as const satisfies ChatThreadRef;
      queueChatSend(created, html);
      return created;
    })();
  useInspectorTabsStore.getState().openChat({ id: threadRef.threadId, label });
};

/**
 * The message as the composer would have spelled it: the corpus chip's
 * `<entity-mention>` tag (the attrs `ChatMention` renders) and the question.
 * Built through the DOM so the reader's text is escaped as text.
 */
const corpusQuestionHtml = ({
  question,
  scope,
  scopeLabel,
}: Omit<AskPublicLawInChatOptions, "label">): string => {
  const attrs = toChatMentionNodeAttrs({
    category: "corpus",
    kind: "corpus",
    label: scopeLabel,
    mimeType: null,
    scope,
  });
  const paragraph = document.createElement("p");
  const chip = document.createElement("entity-mention");
  chip.dataset["id"] = attrs.id ?? "";
  chip.dataset["label"] = attrs.label ?? "";
  chip.dataset["category"] = attrs.category;
  chip.dataset["kind"] = attrs.kind;
  paragraph.append(chip, ` ${question}`);
  return paragraph.outerHTML;
};
