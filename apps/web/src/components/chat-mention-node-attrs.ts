import type { MentionNodeAttrs } from "@tiptap/extension-mention";

import type { ChatMentionOption } from "@/components/chat-mention-extension";

export const toChatMentionNodeAttrs = (
  mention: ChatMentionOption,
): MentionNodeAttrs & {
  category: ChatMentionOption["category"];
  kind: ChatMentionOption["kind"];
  mimeType: string | null;
  matterId: string | undefined;
  sourceWorkspaceId: string | undefined;
} => ({
  id: mention.resource.id,
  label: mention.label,
  category: mention.category,
  kind: mention.kind,
  mimeType: mention.mimeType,
  matterId: mention.category === "entity" ? mention.matterId : undefined,
  sourceWorkspaceId:
    mention.category === "entity" ? mention.sourceWorkspaceId : undefined,
});
