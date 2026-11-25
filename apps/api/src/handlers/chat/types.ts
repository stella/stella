import type { MessagePart, UIMessage } from "@tanstack/ai-client";
import type {
  DocumentPart,
  ImagePart,
  ThinkingPart,
  ToolCallPart,
} from "@tanstack/ai/client";

import type { ReasoningProvenance } from "@stll/ai-catalog";
import type { UnscannedContentReason } from "@stll/api-contract/file-scan-warnings";
import type { FolioAgentToolName } from "@stll/folio-agents";
import type {
  FolioAgentToolInputByName,
  FolioToolCallResultFor,
} from "@stll/folio-agents/tool-contract";

import type {
  ChatMessageMetadata,
  ChatTurnOutcome,
} from "@/api/handlers/chat/persisted-chat-types";
import type { AutoApplySuggestChangesOutput } from "@/api/handlers/chat/tools/auto-apply-suggest-changes-tools";
import type {
  ChatBuiltinApprovalToolName,
  ChatTools,
} from "@/api/handlers/chat/tools/chat-tools";
import type { SUGGEST_CHANGES_TOOL_NAME } from "@/api/handlers/chat/tools/folio-agent-tools";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  ChatClientToolsFor,
  ChatUIToolsFor,
} from "@/api/lib/chat/chat-tool-types";
import type {
  PersistedJsonObject,
  PersistedToolProviderMetadata,
} from "@/api/lib/chat/persisted-message-content";

export type { ChatTurnTiming } from "@stll/api-contract/chat";

export type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";

export { CHAT_REFERENCE_HREF_PREFIXES } from "@/api/lib/chat/references";
export type { ChatMention } from "@/api/lib/chat/references";

export type {
  ChatAnonRestoration,
  ChatAnswerQuoteCheck,
  ChatCompactionSummary,
  ChatMessageMetadata,
  ChatMessageRole,
  ChatMessageUsage,
  ChatSubagentPart,
  ChatTurnOutcome,
  ChatTurnSpend,
  PersistedChatMessageContent,
  PersistedChatMessageContentV3,
  PersistedSubagentHandle,
  PersistedSubagentPart,
} from "@/api/handlers/chat/persisted-chat-types";

type SchemaInferredChatUITools = ChatUIToolsFor<ChatTools>;
type RegisteredFolioAgentToolName = Extract<
  keyof SchemaInferredChatUITools,
  FolioAgentToolName
>;
type FolioAgentChatUITools = {
  [TName in RegisteredFolioAgentToolName]: {
    input: FolioAgentToolInputByName[TName];
    output: TName extends typeof SUGGEST_CHANGES_TOOL_NAME
      ? FolioToolCallResultFor<TName> | AutoApplySuggestChangesOutput
      : FolioToolCallResultFor<TName>;
  };
};

/**
 * Raw JSON Schema does not carry a TypeScript input/output parameter through
 * TanStack's Standard Schema inference. Restore Folio's exact contract from
 * its exported name-indexed maps for only the Folio tools actually registered
 * in ChatTools; adding or removing a registered Folio name changes this map
 * automatically. `suggest_changes` has two registrations: the client-executed
 * queue variant answers with Folio's result envelope, the server-executed
 * apply variant with its own version-write outcome.
 */
export type ChatUITools = Omit<
  SchemaInferredChatUITools,
  RegisteredFolioAgentToolName
> &
  FolioAgentChatUITools;
export type ChatClientTools = ChatClientToolsFor<
  ChatTools,
  ChatBuiltinApprovalToolName
>;

export type ChatAttachmentMetadata = {
  filename?: string | undefined;
  placeholder?: string | undefined;
  /**
   * Why some of the file's content was not scanned when it was stored, read
   * from the file's own scan warnings; absent when everything was scanned.
   */
  unscannedContent?: UnscannedContentReason[] | undefined;
};

export type ChatAttachmentPart =
  ImagePart<ChatAttachmentMetadata> | DocumentPart<ChatAttachmentMetadata>;

type SdkChatPart = MessagePart<ChatClientTools>;
export type ChatTanStackPart =
  | Exclude<SdkChatPart, { type: "text" | "thinking" | "tool-call" }>
  | (Extract<SdkChatPart, { type: "text" }> & {
      /** Provider artefacts a writer stored with the text, kept as stored. */
      providerMetadata?: PersistedJsonObject;
    })
  | (Extract<SdkChatPart, { type: "tool-call" }> &
      Pick<ToolCallPart, "metadata"> & {
        /** Provider artefacts a writer stored with the call, kept as stored. */
        providerMetadata?: PersistedToolProviderMetadata;
      })
  | (ThinkingPart & {
      /**
       * Server-issued replay identity; historical parts may have none. One
       * naming a provider or format this release does not list (a newer
       * release's, or one since retired) is kept as stored but unverified:
       * replay accepts only a provenance it can verify.
       */
      provenance?: ReasoningProvenance | PersistedJsonObject;
      /** Provider artefacts a writer stored with the reasoning, kept as stored. */
      providerMetadata?: PersistedJsonObject;
    });

export type ChatPart = ChatTanStackPart;
export type PersistableChatPartType = ChatTanStackPart["type"];

// UIMessage's other fields do not depend on its tool map. Omitting from the
// tool-typed message would evaluate ChatTools eagerly, and ChatTools reaches
// ChatMessage again through the chat history tools: a circular alias.
export type ChatMessage = Omit<UIMessage, "parts"> & {
  parts: ChatPart[];
  metadata?: ChatMessageMetadata;
  revision?: number;
  edited?: boolean;
};

export type PersistableChatMessageCandidate = {
  createdAt?: NonNullable<ChatMessage["createdAt"]>;
  id: SafeId<"chatMessage">;
  metadata?: ChatMessageMetadata | undefined;
  parts: ChatMessage["parts"];
  role: ChatMessage["role"];
};

/** Opaque proof assigned only after every part passes the persistence policy. */
declare const persistableChatMessageProof: unique symbol;
export type PersistableChatMessage = {
  createdAt?: NonNullable<ChatMessage["createdAt"]>;
  id: SafeId<"chatMessage">;
  metadata?: ChatMessageMetadata;
  parts: ChatMessage["parts"];
  readonly [persistableChatMessageProof]: true;
  role: ChatMessage["role"];
};

/** Proof that an assistant message closes an accepted turn exactly once. */
export type PersistableTerminalAssistantMessage = PersistableChatMessage & {
  metadata: ChatMessageMetadata & { turnOutcome: ChatTurnOutcome };
  role: "assistant";
};

export type ChatMessageContentCandidate = {
  data: ChatMessage["parts"];
  metadata?: ChatMessageMetadata | undefined;
};
