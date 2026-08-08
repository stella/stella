import { EventType } from "@tanstack/ai";
import type {
  AbortInfo,
  ChatMiddleware,
  ChatMiddlewareContext,
  ChatMiddlewarePhase,
  ContentPart,
  ErrorInfo,
  FinishInfo,
  StreamChunk,
  UIMessage,
} from "@tanstack/ai";
import type {
  ChatClientState,
  ConnectionStatus,
  ToolCallState,
  ToolResultState,
} from "@tanstack/ai-client";
import { panic } from "better-result";

/**
 * Full middleware-surface canary. This intentionally covers nonterminal hooks
 * too: any upstream middleware addition/removal forces an explicit Stella
 * boundary review instead of silently bypassing the lifecycle adapter.
 */
export const TANSTACK_CHAT_MIDDLEWARE_SEAM = {
  name: "configuration",
  onAbort: "terminal",
  onAfterToolCall: "nonterminal",
  onBeforeToolCall: "nonterminal",
  onChunk: "nonterminal",
  onConfig: "nonterminal",
  onError: "terminal",
  onFinish: "terminal",
  onIteration: "nonterminal",
  onShouldContinue: "nonterminal",
  onStart: "nonterminal",
  onStructuredOutputConfig: "nonterminal",
  onToolPhaseComplete: "nonterminal",
  onUsage: "nonterminal",
  optionalRequires: "configuration",
  provides: "configuration",
  requires: "configuration",
  sandbox: "nonterminal",
  setup: "nonterminal",
} as const satisfies Record<
  keyof ChatMiddleware,
  "configuration" | "nonterminal" | "terminal"
>;

/** Compile-time seam with every phase passed to middleware onConfig. */
export const TANSTACK_CHAT_MIDDLEWARE_PHASE_POLICY = {
  afterTools: "agent-loop",
  beforeModel: "agent-loop",
  beforeTools: "agent-loop",
  init: "initialization",
  modelStream: "agent-loop",
  structuredOutput: "structured-output",
} as const satisfies Record<
  ChatMiddlewarePhase,
  "agent-loop" | "initialization" | "structured-output"
>;

export type TanStackChatTerminalEvent =
  | { type: "completed"; context: ChatMiddlewareContext; info: FinishInfo }
  | { type: "failed"; context: ChatMiddlewareContext; info: ErrorInfo }
  | { type: "aborted"; context: ChatMiddlewareContext; info: AbortInfo };

type TanStackTerminalHooks = Required<
  Pick<ChatMiddleware, "onAbort" | "onError" | "onFinish">
>;

/**
 * The only adapter from TanStack terminal hooks into Stella. TanStack promises
 * exactly one terminal hook per run; this guard fails loudly if that contract
 * changes at runtime while the types remain source-compatible.
 */
export const createTanStackTerminalHooks = (
  onTerminal: (event: TanStackChatTerminalEvent) => Promise<void> | void,
): TanStackTerminalHooks => {
  let terminalSeen = false;
  const once = async (event: TanStackChatTerminalEvent): Promise<void> => {
    if (terminalSeen) {
      return panic("TanStack emitted more than one terminal hook for one run");
    }
    terminalSeen = true;
    await onTerminal(event);
  };
  return {
    onAbort: async (context, info) =>
      await once({ type: "aborted", context, info }),
    onError: async (context, info) =>
      await once({ type: "failed", context, info }),
    onFinish: async (context, info) =>
      await once({ type: "completed", context, info }),
  };
};

/**
 * Compile-time seam with TanStack's AG-UI stream union. Adding or renaming an
 * upstream event must fail Stella's typecheck until its lifecycle semantics are
 * chosen here. Consumers may pass content events through, but they may not
 * maintain independent partial terminal-event allowlists.
 */
export const TANSTACK_STREAM_EVENT_LIFECYCLE = {
  CUSTOM: "content",
  MESSAGES_SNAPSHOT: "content",
  REASONING_ENCRYPTED_VALUE: "content",
  REASONING_END: "content",
  REASONING_MESSAGE_CONTENT: "content",
  REASONING_MESSAGE_END: "content",
  REASONING_MESSAGE_START: "content",
  REASONING_START: "content",
  RUN_ERROR: "failed",
  RUN_FINISHED: "terminal",
  RUN_STARTED: "started",
  STATE_DELTA: "content",
  STATE_SNAPSHOT: "content",
  STEP_FINISHED: "content",
  STEP_STARTED: "content",
  TEXT_MESSAGE_CONTENT: "content",
  TEXT_MESSAGE_END: "content",
  TEXT_MESSAGE_START: "content",
  TOOL_CALL_ARGS: "content",
  TOOL_CALL_END: "content",
  TOOL_CALL_RESULT: "content",
  TOOL_CALL_START: "content",
} as const satisfies Record<
  StreamChunk["type"],
  "content" | "failed" | "started" | "terminal"
>;

export const tanStackStreamEventLifecycle = (
  chunk: StreamChunk,
): "completed" | "content" | "failed" | "started" | "waiting" => {
  if (chunk.type === EventType.RUN_FINISHED) {
    return chunk.outcome?.type === "interrupt" ? "waiting" : "completed";
  }
  return TANSTACK_STREAM_EVENT_LIFECYCLE[chunk.type];
};

/** Compile-time seam with TanStack's browser chat state union. */
export const TANSTACK_CHAT_CLIENT_STATE_LIFECYCLE = {
  error: "failed",
  ready: "idle",
  streaming: "active",
  submitted: "active",
} as const satisfies Record<ChatClientState, "active" | "failed" | "idle">;

/** Compile-time seam with TanStack's subscription connection state. */
export const TANSTACK_CONNECTION_STATE_LIFECYCLE = {
  connected: "online",
  connecting: "connecting",
  disconnected: "offline",
  error: "failed",
} as const satisfies Record<
  ConnectionStatus,
  "connecting" | "failed" | "offline" | "online"
>;

/** Compile-time seam with roles accepted by TanStack's chat protocol. */
export const TANSTACK_CHAT_MESSAGE_ROLE_POLICY = {
  assistant: "conversation",
  system: "instructions",
  user: "conversation",
} as const satisfies Record<UIMessage["role"], "conversation" | "instructions">;

/** Compile-time seam with rich content accepted inside tool results. */
export const TANSTACK_CONTENT_PART_POLICY = {
  audio: "media",
  document: "media",
  image: "media",
  text: "text",
  video: "media",
} as const satisfies Record<ContentPart["type"], "media" | "text">;

/** Compile-time seam with every TanStack tool-call state. */
export const TANSTACK_TOOL_CALL_STATE_LIFECYCLE = {
  "approval-requested": "waiting",
  "approval-responded": "settled",
  "awaiting-input": "active",
  complete: "settled",
  error: "settled",
  "input-complete": "settled",
  "input-streaming": "active",
} as const satisfies Record<ToolCallState, "active" | "settled" | "waiting">;

/** Compile-time seam with every TanStack tool-result state. */
export const TANSTACK_TOOL_RESULT_STATE_LIFECYCLE = {
  complete: "settled",
  error: "settled",
  streaming: "active",
} as const satisfies Record<ToolResultState, "active" | "settled">;
