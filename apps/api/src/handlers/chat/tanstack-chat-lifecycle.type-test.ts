import type {
  ChatMiddleware,
  ChatMiddlewarePhase,
  ContentPart,
  UIMessage,
} from "@tanstack/ai";
import type { ChatClientState, ConnectionStatus } from "@tanstack/ai-client";

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
  onGuardToolCall: "nonterminal",
  onInterruptBoundary: "nonterminal",
  onInterruptResolution: "nonterminal",
  onIteration: "nonterminal",
  // A pre-output model failure can retry; only onError terminates the run.
  onModelError: "nonterminal",
  onShouldContinue: "nonterminal",
  onStart: "nonterminal",
  onStructuredOutputConfig: "nonterminal",
  onToolPhaseComplete: "nonterminal",
  onUsage: "nonterminal",
  optionalRequires: "configuration",
  provides: "configuration",
  requires: "configuration",
  routedSubagentPersistence: "configuration",
  sandbox: "nonterminal",
  setup: "nonterminal",
} as const satisfies Record<
  keyof ChatMiddleware,
  "configuration" | "nonterminal" | "terminal"
>;

/** Compile-time seam with every phase passed to middleware onConfig. */
export const TANSTACK_CHAT_MIDDLEWARE_PHASE_POLICY = {
  afterModel: "agent-loop",
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
  activity: "presentation",
  assistant: "conversation",
  system: "instructions",
  user: "conversation",
} as const satisfies Record<
  UIMessage["role"],
  "conversation" | "instructions" | "presentation"
>;

/** Compile-time seam with rich content accepted inside tool results. */
export const TANSTACK_CONTENT_PART_POLICY = {
  audio: "media",
  document: "media",
  image: "media",
  text: "text",
  video: "media",
} as const satisfies Record<ContentPart["type"], "media" | "text">;
