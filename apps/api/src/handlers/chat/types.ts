import type { TokenUsage } from "@tanstack/ai";
import type { MessagePart, UIMessage } from "@tanstack/ai-client";
import type {
  DocumentPart,
  ImagePart,
  ThinkingPart,
  ToolCallPart,
} from "@tanstack/ai/client";

import type {
  ReasoningEffort,
  ReasoningProvenance,
  TanStackAIProvider,
} from "@stll/ai-catalog";
import type { ActionAdmissionRefusal } from "@stll/api-contract/action-admission";
import type { ChatTurnTiming } from "@stll/api-contract/chat";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import type { ChatTurnResumeProbe } from "@stll/chat/resume-contract";
import type { FolioAgentToolName } from "@stll/folio-agents";
import type {
  FolioAgentToolInputByName,
  FolioToolCallResultFor,
} from "@stll/folio-agents/tool-contract";

import type {
  ChatTurnCancellationReason,
  ChatTurnInterruptionReason,
} from "@/api/handlers/chat/chat-turn-state";
import type { AutoApplySuggestChangesOutput } from "@/api/handlers/chat/tools/auto-apply-suggest-changes-tools";
import type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";
import type {
  ChatBuiltinApprovalToolName,
  ChatTools,
} from "@/api/handlers/chat/tools/chat-tools";
import type { SUGGEST_CHANGES_TOOL_NAME } from "@/api/handlers/chat/tools/folio-agent-tools";
import type { AIErrorKind } from "@/api/lib/ai-error";
import type { SafeId } from "@/api/lib/branded-types";
import type { GeneratedDocumentActiveDraftContext } from "@/api/lib/chat/active-draft-context";
import type {
  ChatClientToolsFor,
  ChatUIToolsFor,
} from "@/api/lib/chat/chat-tool-types";
import type { ChatContextNotice } from "@/api/lib/chat/context-notice";
import type {
  persistedChatMessageContentV3Proof,
  PersistedJsonObject,
  PersistedToolCallPart,
  PersistedToolProviderMetadata,
  PersistedToolResultPart,
} from "@/api/lib/chat/persisted-message-content";
import type { ChatRefContext, ChatRefEncoding } from "@/api/lib/chat/ref-token";
import type { ChatMentionsData } from "@/api/lib/chat/references";

export type { ChatTurnTiming } from "@stll/api-contract/chat";

export type { ChatSourceDocument } from "@/api/handlers/chat/tools/chat-source-document";

export { CHAT_REFERENCE_HREF_PREFIXES } from "@/api/lib/chat/references";
export type { ChatMention } from "@/api/lib/chat/references";

export type ChatAnonRestoration = {
  placeholder: string;
  original: string;
};

type ChatAnonRestorationsData = {
  pairs: ChatAnonRestoration[];
};

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

/**
 * Server-owned terminal state for one accepted assistant turn.
 *
 * Every newly generated assistant message carries exactly one branch. Older
 * persisted messages predate this field and are treated as completed only when
 * they contain user-visible content. Incoming clients can never set or replace
 * this value; chat-schema restores it from the persisted server copy.
 */
export type ChatTurnOutcome =
  | {
      type: "awaiting-user";
      interaction:
        | { type: "approval"; toolCallId: string }
        | { type: "ask-user"; toolCallId: string }
        /**
         * A client-executed tool (no server `execute`, e.g. create-document)
         * whose input is complete and whose result the chat client posts back
         * as a native interrupt resolution.
         */
        | { type: "client-tool"; toolCallId: string };
    }
  | { type: "completed" }
  | { type: "cancelled"; reason: ChatTurnCancellationReason }
  | {
      type: "failed";
      error: AIErrorKind;
      /**
       * Read by the page as well, so it carries the wire shape. Every API
       * producer builds it through the redactor (`createProviderDiagnostic`,
       * `redactedProviderDiagnostic`).
       */
      providerDiagnostic?: ProviderDiagnostic;
      refusal?: ActionAdmissionRefusal;
    }
  | {
      type: "interrupted";
      reason: ChatTurnInterruptionReason;
    };

export type ChatMessageMetadata = {
  /** Server-owned active execution time; human interaction waits are excluded. */
  turnTiming?: ChatTurnTiming | null | undefined;
  /** Server-owned generated-document draft binding. Incoming client metadata
   * deliberately does not accept this field. */
  activeDraftContext?: GeneratedDocumentActiveDraftContext | undefined;
  anonRestorations?: ChatAnonRestorationsData | undefined;
  /** Server-owned: what the answer's context left out (`context-notice.ts`).
   * `null` only on the live stream, withdrawing a notice a replaced attempt
   * streamed; never stored. Incoming client metadata deliberately does not
   * accept this field. */
  contextNotice?: ChatContextNotice | null | undefined;
  docxEditPreferences?:
    | {
        docxEditRepresentation?: "tracked-changes" | "direct" | undefined;
        editApplyMode?: "manual" | "auto" | undefined;
      }
    | undefined;
  mentions?: ChatMentionsData | undefined;
  /** Server-owned marker for the ID representation persisted in tool parts.
   * Incoming client metadata deliberately does not accept this field. */
  refEncoding?: ChatRefEncoding | undefined;
  /** Server-owned replay context for persisted tool references. */
  refContext?: ChatRefContext | undefined;
  /** Server-owned native interrupt identity, retained with the transcript
   * after the delivery log expires. Incoming metadata cannot set this. */
  resumeSnapshot?:
    | Extract<ChatTurnResumeProbe, { type: "transcript" }>["resumeSnapshot"]
    | undefined;
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
  /** Server-owned terminal state. Incoming client metadata validation
   * deliberately does not accept this field. */
  turnOutcome?: ChatTurnOutcome | undefined;
  /** Model that owns an assistant turn, including its approval resumes. */
  turnModel?:
    | {
        provider: TanStackAIProvider;
        model: string;
        reasoningEffort?: ReasoningEffort;
      }
    | undefined;
  usage?: ChatMessageUsage | undefined;
};

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

export type ChatMessageContentCandidate = {
  data: ChatMessage["parts"];
  metadata?: ChatMessageMetadata | undefined;
};

type PersistedChatToolPartV3 = PersistedToolCallPart | PersistedToolResultPart;

export type PersistedChatMessageContentV3 = {
  data: (
    | PersistedChatToolPartV3
    | Exclude<ChatPart, { type: "tool-call" | "tool-result" }>
  )[];
  metadata?: ChatMessageMetadata | undefined;
  readonly [persistedChatMessageContentV3Proof]: true;
  version: 3;
};

/** Stored rows are upgraded to v3 before runtime readers start. */
export type PersistedChatMessageContent = PersistedChatMessageContentV3;
