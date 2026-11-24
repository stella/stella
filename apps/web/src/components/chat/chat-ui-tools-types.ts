import type { HarnessChatToolName } from "@stll/api-contract/chat-tool-activity";
import type { UnscannedContentReason } from "@stll/api-contract/file-scan-warnings";
import type { FolioAgentToolName } from "@stll/folio-agents";

import type {
  BuiltInChatToolPolicyKindByName,
  ChatAnonRestoration,
  ChatClientTools,
  ChatMessage,
  ChatPart as TanStackChatPart,
  ChatUITools,
  WebApiRoutes,
} from "@/lib/api-contract";

export type { ChatAnonRestoration, ChatClientTools, ChatMessage, ChatUITools };
export type ChatPart = TanStackChatPart;
type AnswerRevision = Partial<
  Pick<
    WebApiRoutes["chat"]["threads"][":threadId"]["messages"]["get"]["response"][200]["messages"][number],
    "revision" | "edited"
  >
>;
export type PersistedChatMessage = ChatMessage & AnswerRevision;
type TanStackChatToolCallPart = Extract<
  TanStackChatPart,
  { type: "tool-call" }
>;
export type BuiltInChatToolName = keyof BuiltInChatToolPolicyKindByName;
export type BuiltInChatToolCallPart = {
  [TName in BuiltInChatToolName]: Omit<
    Extract<TanStackChatToolCallPart, { name: TName }>,
    "input" | "output"
  > & {
    input?: ChatUITools[TName]["input"];
    output?: ChatUITools[TName]["output"];
  };
}[BuiltInChatToolName];
type ExternalMcpChatToolCallPart = Extract<
  TanStackChatToolCallPart,
  { name: `mcp__${string}` }
>;
declare const opaquePersistedChatToolCallProof: unique symbol;
/**
 * Proof assigned after a persisted tool call passes the protocol-shape guard
 * and its name is confirmed absent from both current tool namespaces.
 */
export type OpaquePersistedChatToolCallPart = TanStackChatToolCallPart & {
  readonly [opaquePersistedChatToolCallProof]: true;
};

/**
 * TanStack deliberately leaves JSON-schema tool payloads unknown. At Stella's
 * rendering boundary, built-in payloads retain the types derived from the same
 * Standard Schema tool map; external MCP and opaque historical payloads remain
 * unknown.
 */
export type RegisteredChatUIToolCallPart =
  BuiltInChatToolCallPart | ExternalMcpChatToolCallPart;
type RegisteredFolioAgentToolName = Extract<
  keyof ChatUITools,
  FolioAgentToolName
>;
export type RegisteredFolioAgentToolCallPart<
  TName extends RegisteredFolioAgentToolName = RegisteredFolioAgentToolName,
> = {
  [TCurrentName in TName]: Extract<
    RegisteredChatUIToolCallPart,
    { name: TCurrentName }
  > & {
    input: ChatUITools[TCurrentName]["input"];
  };
}[TName];
export type ChatUIToolCallPart =
  RegisteredChatUIToolCallPart | OpaquePersistedChatToolCallPart;
export type ChatUIPart =
  Exclude<TanStackChatPart, { type: "tool-call" }> | ChatUIToolCallPart;
export type ChatUIMessage = Omit<PersistedChatMessage, "parts"> & {
  parts: ChatUIPart[];
};
export type ChatToolCallPart = TanStackChatToolCallPart;
export type ChatAttachmentPart = Extract<
  ChatPart,
  { type: "document" | "image" }
> & {
  metadata?: {
    filename?: string | undefined;
    placeholder?: string | undefined;
    /** Why some of the file's content was not scanned when it was stored. */
    unscannedContent?: UnscannedContentReason[] | undefined;
  };
};
export type ChatMessageMetadata = NonNullable<ChatMessage["metadata"]>;
export type SharedChatUITools = Pick<ChatUITools, "ask-user">;
export type AskUserOutput = SharedChatUITools["ask-user"]["output"];
// These tools have dedicated user-input cards or draft UI instead of the
// approval flow. Keep them out of the approval set so their owning cards
// handle the interaction.
export type BuiltInApprovalToolName = Exclude<
  keyof ChatUITools,
  "ask-user" | "create-document" | "request_secret" | "connect_connector"
>;
/**
 * A harness-native step of a coding agent on the member's computer. The
 * member approves one like any other call (`isApprovalToolName` accepts its
 * name), and its input is the contract's (`chat-local-run-tool`).
 */
type HarnessToolName = HarnessChatToolName;
export type HarnessChatToolCallPart = Omit<TanStackChatToolCallPart, "name"> & {
  name: HarnessToolName;
};
export type ApprovalToolName =
  BuiltInApprovalToolName | HarnessToolName | `mcp__${string}`;
export type ToolApprovalGrant = ApprovalToolName | `mcp-connector:${string}`;
export type ApprovalToolPart = (
  RegisteredChatUIToolCallPart | HarnessChatToolCallPart
) & {
  name: ApprovalToolName;
  approval: {
    approved?: boolean | undefined;
    id: string;
    needsApproval: boolean;
  };
};
export type AskUserInput = SharedChatUITools["ask-user"]["input"];
