import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import { panic } from "better-result";

import { formatChatCorpusId } from "@stll/api-contract";

import type { ChatMentionOption } from "@/components/chat-mention-extension";

/**
 * The id a mention's chip carries: its row, or a source scope's own id (a
 * corpus scope, a registry slug, a connector slug).
 */
export const chatMentionOptionId = (mention: ChatMentionOption): string => {
  switch (mention.category) {
    case "corpus":
      return formatChatCorpusId(mention.scope);
    case "registry":
      return mention.registry;
    case "connector":
      return mention.connector;
    case "entity":
    case "workspace":
    case "decision":
      return mention.resource.id;
    default:
      mention satisfies never;
      return panic(`Unhandled mention category: ${String(mention)}`);
  }
};

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
