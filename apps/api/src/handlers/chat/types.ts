import type { TokenUsage } from "@tanstack/ai";
import type { MessagePart, UIMessage } from "@tanstack/ai-client";
import type { DocumentPart, ImagePart } from "@tanstack/ai/client";

import type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import type {
  ChatBuiltinApprovalToolName,
  ChatTools,
} from "@/api/handlers/chat/tools/chat-tools";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  ChatClientToolsFor,
  ChatUIToolsFor,
} from "@/api/lib/chat/chat-tool-types";
import type { persistedChatMessageContentProof } from "@/api/lib/chat/persisted-message-content";
import type { ChatMentionsData } from "@/api/lib/chat/references";
import type { UserFileUrl } from "@/api/lib/user-files/types";

export {
  CHAT_MENTION_CATEGORIES,
  CHAT_MENTION_HREF_PREFIXES,
  CHAT_REFERENCE_HREF_PREFIXES,
} from "@/api/lib/chat/references";
export type {
  ChatMention,
  ChatMentionCategory,
  ChatMentionHref,
  ChatMentionHrefPrefix,
  ChatMentionHrefPrefixMap,
  ChatMentionsData,
  ChatReferenceCategory,
  ChatReferenceHrefPrefix,
} from "@/api/lib/chat/references";

export type ChatUserFileUrl = UserFileUrl;

export type ChatAnonRestoration = {
  placeholder: string;
  original: string;
};

export type ChatAnonRestorationsData = {
  pairs: ChatAnonRestoration[];
};

export type ChatUITools = ChatUIToolsFor<ChatTools>;
export type ChatClientTools = ChatClientToolsFor<
  ChatTools,
  ChatBuiltinApprovalToolName
>;

export type ChatAttachmentMetadata = {
  filename?: string | undefined;
  placeholder?: string | undefined;
};

export type ChatAttachmentPart =
  | ImagePart<ChatAttachmentMetadata>
  | DocumentPart<ChatAttachmentMetadata>;

export type ChatTanStackPart = MessagePart<ChatClientTools>;
export type ChatPart = ChatTanStackPart;
export type PersistableChatPartType =
  | "document"
  | "image"
  | "structured-output"
  | "text"
  | "thinking"
  | "tool-call"
  | "tool-result";

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
  docxEditPreferences?:
    | {
        docxEditRepresentation?: "tracked-changes" | "direct" | undefined;
        editApplyMode?: "manual" | "auto" | undefined;
      }
    | undefined;
  mentions?: ChatMentionsData | undefined;
  /** Server-owned provenance. Incoming client metadata validation deliberately
   *  does not accept this field. */
  serverProvenance?:
    | {
        type: "search-summary";
        version: 1;
      }
    | undefined;
  /** Server-owned grounded documents. Incoming client metadata validation
   * deliberately does not accept this field. */
  sourceDocuments?: ChatSourceDocument[] | undefined;
  usage?: ChatMessageUsage | undefined;
};

export type ChatMessage = UIMessage<ChatClientTools> & {
  metadata?: ChatMessageMetadata | undefined;
};

export type PersistableChatMessageCandidate = {
  createdAt?: ChatMessage["createdAt"];
  id: SafeId<"chatMessage">;
  metadata?: ChatMessageMetadata | undefined;
  parts: ChatMessage["parts"];
  role: ChatMessage["role"];
};

/** Opaque proof assigned only after every part passes the persistence policy. */
declare const persistableChatMessageProof: unique symbol;
export type PersistableChatMessage = {
  createdAt?: ChatMessage["createdAt"];
  id: SafeId<"chatMessage">;
  metadata?: ChatMessageMetadata | undefined;
  parts: ChatMessage["parts"];
  readonly [persistableChatMessageProof]: true;
  role: ChatMessage["role"];
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

export type ChatMessageContentCandidate = {
  data: ChatMessage["parts"];
  metadata?: ChatMessageMetadata | undefined;
  version: 2;
};

export type ChatMessageContent = {
  data: ChatMessage["parts"];
  metadata?: ChatMessageMetadata | undefined;
  readonly [persistedChatMessageContentProof]: true;
  version: 2;
};

export type PersistedChatMessageContent =
  | LegacyChatMessageContent
  | ChatMessageContent;
