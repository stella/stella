import type { MentionNodeAttrs } from "@tiptap/extension-mention";

import { formatChatCorpusId } from "@stll/api-contract";

import type { ChatMentionOption } from "@/components/chat-mention-extension";

/** The id a mention's chip carries: its row, or a corpus scope's own id. */
export const chatMentionOptionId = (mention: ChatMentionOption): string =>
  mention.category === "corpus"
    ? formatChatCorpusId(mention.scope)
    : mention.resource.id;

export const toChatMentionNodeAttrs = (
  mention: ChatMentionOption,
): MentionNodeAttrs & {
  category: ChatMentionOption["category"];
  kind: ChatMentionOption["kind"];
  mimeType: string | null;
  matterId: string | undefined;
  sourceWorkspaceId: string | undefined;
} => ({
  id: chatMentionOptionId(mention),
  label: mention.label,
  category: mention.category,
  kind: mention.kind,
  mimeType: mention.mimeType,
  matterId: mention.category === "entity" ? mention.matterId : undefined,
  sourceWorkspaceId:
    mention.category === "entity" ? mention.sourceWorkspaceId : undefined,
});
