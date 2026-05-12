import type { InferUITools, UIMessage } from "ai";

import type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import type { ChatTools } from "@/api/handlers/chat/tools/chat-tools";
import type { UserFileUrl } from "@/api/handlers/user-files/types";

export const CHAT_MENTION_CATEGORIES = ["entity", "workspace"] as const;

export type ChatMentionCategory = (typeof CHAT_MENTION_CATEGORIES)[number];

export type ChatMentionHrefPrefix = `#stella-${ChatMentionCategory}=`;

export type ChatMentionHref = `${ChatMentionHrefPrefix}${string}`;

export type ChatMentionHrefPrefixMap = {
  [TCategory in ChatMentionCategory]: `#stella-${TCategory}=`;
};

export const CHAT_MENTION_HREF_PREFIXES = {
  entity: "#stella-entity=",
  workspace: "#stella-workspace=",
} as const satisfies ChatMentionHrefPrefixMap;

export const CHAT_REFERENCE_HREF_PREFIXES = {
  ...CHAT_MENTION_HREF_PREFIXES,
  decision: "#stella-decision=",
} as const;

export type ChatReferenceHrefPrefix =
  (typeof CHAT_REFERENCE_HREF_PREFIXES)[keyof typeof CHAT_REFERENCE_HREF_PREFIXES];

export type ChatReferenceCategory = keyof typeof CHAT_REFERENCE_HREF_PREFIXES;

type BaseChatMention = {
  id: string;
  label: string;
};

export type ChatMention =
  | (BaseChatMention & {
      category: "entity";
      workspaceId: string | null;
    })
  | (BaseChatMention & { category: "workspace" });

export type ChatMentionsData = {
  mentions: ChatMention[];
};

export type ChatUserFileUrl = UserFileUrl;

export type ChatAnonRestoration = {
  placeholder: string;
  original: string;
};

export type ChatAnonRestorationsData = {
  pairs: ChatAnonRestoration[];
};

export type ChatUITools = InferUITools<ChatTools>;
export type ChatUIDataTypes = {
  "stella-anon-restorations": ChatAnonRestorationsData;
  "stella-mentions": ChatMentionsData;
  "stella-source-document": ChatSourceDocument;
};

export type ChatMessage = UIMessage<never, ChatUIDataTypes, ChatUITools>;
export type ChatPart = ChatMessage["parts"][number];

export type ChatMessageRole = UIMessage["role"];

/** Versioned envelope for the chatMessages JSONB column.
 *  Bump the version and add a new variant when the parts
 *  shape changes; migrate in-place by reading the version
 *  and transforming old shapes on read. */
export type ChatMessageContent = {
  version: 1;
  data: ChatMessage["parts"];
};
export type PersistedChatMessageContent = ChatMessageContent;
