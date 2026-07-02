import type { TokenUsage } from "@tanstack/ai";
import type { MessagePart, UIMessage } from "@tanstack/ai-client";
import type { DocumentPart, ImagePart } from "@tanstack/ai/client";

import type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import type {
  ChatClientToolsFor,
  ChatUIToolsFor,
} from "@/api/handlers/chat/tools/chat-tool-types";
import type { ChatTools } from "@/api/handlers/chat/tools/chat-tools";
import type { UserFileUrl } from "@/api/handlers/user-files/types";
import type { SafeId } from "@/api/lib/branded-types";

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

export type ChatUITools = ChatUIToolsFor<ChatTools>;
export type ChatClientTools = ChatClientToolsFor<ChatTools>;

export type ChatAttachmentMetadata = {
  filename?: string | undefined;
  placeholder?: string | undefined;
};

export type ChatAttachmentPart =
  | ImagePart<ChatAttachmentMetadata>
  | DocumentPart<ChatAttachmentMetadata>;

export type ChatTanStackPart = MessagePart<ChatClientTools>;
export type ChatPart = ChatTanStackPart;

export type ChatMessageUsage = Pick<
  TokenUsage,
  "completionTokens" | "promptTokens" | "totalTokens"
> & {
  completionTokensDetails?:
    | Pick<
        NonNullable<TokenUsage["completionTokensDetails"]>,
        "reasoningTokens"
      >
    | undefined;
};

export type ChatMessageMetadata = {
  anonRestorations?: ChatAnonRestorationsData | undefined;
  mentions?: ChatMentionsData | undefined;
  sourceDocuments?: ChatSourceDocument[] | undefined;
  usage?: ChatMessageUsage | undefined;
};

export type ChatMessage = UIMessage<ChatClientTools> & {
  metadata?: ChatMessageMetadata | undefined;
};

export type PersistableChatMessage = ChatMessage & {
  id: SafeId<"chatMessage">;
};

export type ChatMessageRole = UIMessage["role"];

export type ChatCompactionSummary = {
  version: 1;
  blocked: string[];
  constraints: string[];
  criticalContext: string[];
  done: string[];
  goal: string | null;
  inProgress: string[];
  keyDecisions: {
    decision: string;
    rationale: string | null;
  }[];
  modifiedFiles: string[];
  nextSteps: string[];
  readFiles: string[];
};

/** Versioned envelope for the chatMessages JSONB column.
 *  Bump the version and add a new variant when the parts
 *  shape changes; migrate in-place by reading the version
 *  and transforming old shapes on read. */
export type LegacyChatMessageContent = {
  version: 1;
  data: unknown[];
};

export type ChatMessageContent = {
  data: ChatMessage["parts"];
  metadata?: ChatMessageMetadata | undefined;
  version: 2;
};

export type PersistedChatMessageContent =
  | LegacyChatMessageContent
  | ChatMessageContent;
