import type Anthropic from "@anthropic-ai/sdk";
import type { StopReason as BedrockStopReason } from "@aws-sdk/client-bedrock-runtime";
import type { FinishReason as GeminiFinishReason } from "@google/genai";
import type { CompletionResponseStreamChoiceFinishReason as MistralFinishReasons } from "@mistralai/mistralai/models/components";
import type { ChatFinishReasonEnum as OpenRouterFinishReasons } from "@openrouter/sdk/models";
import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import type {
  AnthropicBashTool,
  AnthropicCodeExecutionTool,
  AnthropicComputerUseTool,
  AnthropicMemoryTool,
  AnthropicTextEditorTool,
  AnthropicWebFetchTool,
  AnthropicWebSearchTool,
} from "@tanstack/ai-anthropic/tools";
import { panic } from "better-result";
import type OpenAI from "openai";

import type { TanStackAIProvider } from "@stll/ai-catalog";

import { arrayOrEmpty } from "@/api/lib/array";
import { UnrecognizedProviderStopReasonError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { isRecord } from "@/api/lib/type-guards";

// What a provider's stated reason for ending a response means for the run.
// Each adapter reports the reason on its terminal event
// (`metadata.providerStopReason`, added by the adapter patches), and the
// decision lives here, in one table per provider keyed by the provider SDK's
// own union. A reason an SDK upgrade adds fails the typecheck until it has an
// outcome. A reason the provider sends before its SDK lists it is
// `unrecognized`: reported, and a finished answer only when the step wrote
// something the user sees and called no tool.

/** What a stop reason means for the run. */
export type StopOutcome =
  /** The model ended its turn: `tool_calls` when it called a tool, else
   *  `stop`. */
  | "ended"
  /** Cut off at the output ceiling or the context window; the text so far
   *  stands. */
  | "length"
  /** The provider blocked or filtered the response. */
  | "content_filter"
  /** The provider stopped before the response finished (paused, errored
   *  mid-stream, or no reason at all): the answer is not complete. */
  | "unfinished"
  /** The provider ended on a failure the answer cannot stand on (an invalid
   *  tool call, an unsupported language). */
  | "failed"
  /** A reason no table lists. The step's answer stands when it wrote text
   *  or reasoning the user sees and called no tool; otherwise the run
   *  fails. */
  | "unrecognized";

type AnthropicStopReason = Anthropic.Beta.Messages.BetaStopReason;
type OpenAIStopReason =
  | OpenAI.Responses.ResponseStatus
  | NonNullable<OpenAI.Responses.Response.IncompleteDetails["reason"]>;
type MistralFinishReason =
  | (typeof MistralFinishReasons)[keyof typeof MistralFinishReasons]
  // Sent on the wire, not in the SDK's union: the model's own context limit.
  | "model_length";
type OpenRouterFinishReason =
  (typeof OpenRouterFinishReasons)[keyof typeof OpenRouterFinishReasons];

const ANTHROPIC = {
  end_turn: "ended",
  stop_sequence: "ended",
  tool_use: "ended",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content_filter",
  // A server tool loop paused mid-turn; the turn continues only when the
  // request is sent again, which Stella does not do yet. Until it does, no
  // request may produce it (`refuseTurnPausingRequest`).
  pause_turn: "unfinished",
  // The context was compacted mid-turn; the turn continues only when the
  // request is sent again. Refused the same way.
  compaction: "unfinished",
} as const satisfies Record<AnthropicStopReason, StopOutcome>;

const GOOGLE = {
  STOP: "ended",
  MAX_TOKENS: "length",
  // Resuming needs a continuation token in another request.
  CONTINUATION: "unfinished",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  IMAGE_SAFETY: "content_filter",
  IMAGE_PROHIBITED_CONTENT: "content_filter",
  IMAGE_RECITATION: "content_filter",
  // The model wrote a tool call that could not be parsed or was not
  // offered: nothing usable came back, which is not an empty answer.
  MALFORMED_FUNCTION_CALL: "failed",
  UNEXPECTED_TOOL_CALL: "failed",
  TOO_MANY_TOOL_CALLS: "failed",
  LANGUAGE: "failed",
  NO_IMAGE: "failed",
  IMAGE_OTHER: "failed",
  OTHER: "failed",
  FINISH_REASON_UNSPECIFIED: "failed",
} as const satisfies Record<`${GeminiFinishReason}`, StopOutcome>;

const BEDROCK = {
  end_turn: "ended",
  stop_sequence: "ended",
  tool_use: "ended",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  content_filtered: "content_filter",
  guardrail_intervened: "content_filter",
  malformed_model_output: "failed",
  malformed_tool_use: "failed",
} as const satisfies Record<BedrockStopReason, StopOutcome>;

const MISTRAL = {
  stop: "ended",
  tool_calls: "ended",
  length: "length",
  model_length: "length",
  error: "unfinished",
} as const satisfies Record<MistralFinishReason, StopOutcome>;

// The Responses adapter reports the incomplete reason where there is one,
// and the response status otherwise.
const OPENAI = {
  completed: "ended",
  max_output_tokens: "length",
  content_filter: "content_filter",
  incomplete: "unfinished",
  cancelled: "unfinished",
  in_progress: "unfinished",
  queued: "unfinished",
  failed: "failed",
} as const satisfies Record<OpenAIStopReason, StopOutcome>;

const OPENROUTER = {
  stop: "ended",
  tool_calls: "ended",
  length: "length",
  content_filter: "content_filter",
  // The upstream model failed mid-response.
  error: "unfinished",
} as const satisfies Record<OpenRouterFinishReason, StopOutcome>;

export const PROVIDER_STOP_REASONS: Readonly<
  Record<TanStackAIProvider, Readonly<Record<string, StopOutcome>>>
> = {
  anthropic: ANTHROPIC,
  bedrock: BEDROCK,
  google: GOOGLE,
  mistral: MISTRAL,
  openai: OPENAI,
  openrouter: OPENROUTER,
};

/** The outcome of `reason` from `provider`: `null` is a stream that ended
 *  without one, and a reason the SDK does not know is `unrecognized`. */
const stopOutcomeOf = (
  provider: TanStackAIProvider,
  reason: string | null,
): StopOutcome => {
  if (reason === null) {
    return "unfinished";
  }
  const table = PROVIDER_STOP_REASONS[provider];
  return Object.hasOwn(table, reason)
    ? (table[reason] ?? "unrecognized")
    : "unrecognized";
};

/** The stop reason a finish of an `unrecognized` stop records; the
 *  provider's own value goes to the logs only. */
export const UNRECOGNIZED_STOP_REASON = "unknown";

/** The longest provider value a log line carries. */
const LOGGED_REASON_MAX = 64;

const UNRECOGNIZED_STOP_REASON_SINK = failureSink({
  event: "chat.provider_stop_reason.unrecognized",
  expected: [],
});

/** Report a stop reason no table lists, so the table gets it. */
const reportUnrecognizedStopReason = (
  provider: TanStackAIProvider,
  reason: string,
): void => {
  observeFailure(
    new UnrecognizedProviderStopReasonError({
      message: `A ${provider} response ended with a stop reason no table lists`,
    }),
    {
      sink: UNRECOGNIZED_STOP_REASON_SINK,
      ctx: { feature: "chat.provider_stop_reason", source: provider },
    },
  );
  logger.warn("chat.provider_stop_reason_unrecognized", {
    provider,
    providerStopReason: reason.slice(0, LOGGED_REASON_MAX),
  });
};

// Anthropic ends a turn with `pause_turn` when a server tool (one Anthropic
// runs itself) loops long, and with `compaction` when it compacts the
// context mid-turn. Either turn goes on only when the request is sent again,
// which Stella does not do yet, so both read as unfinished (the table
// above). Until continuation exists, a request that can produce them fails
// loudly here rather than failing turns in production.

type AnthropicNativeToolKind = (
  | AnthropicBashTool
  | AnthropicCodeExecutionTool
  | AnthropicComputerUseTool
  | AnthropicMemoryTool
  | AnthropicTextEditorTool
  | AnthropicWebFetchTool
  | AnthropicWebSearchTool
)["~toolKind"];

/** Whether Anthropic runs the native tool itself, and so may pause the
 *  turn, or hands it back to the client. */
const ANTHROPIC_NATIVE_TOOLS = {
  code_execution: "pauses",
  web_fetch: "pauses",
  web_search: "pauses",
  bash: "client",
  computer_use: "client",
  memory: "client",
  text_editor: "client",
} as const satisfies Record<AnthropicNativeToolKind, "client" | "pauses">;

type AnthropicContextEditType = NonNullable<
  Anthropic.Beta.Messages.BetaContextManagementConfig["edits"]
>[number]["type"];

/** Whether a context edit may stop the turn to compact it. */
const ANTHROPIC_CONTEXT_EDITS = {
  compact_20260112: "pauses",
  clear_thinking_20251015: "continues",
  clear_tool_uses_20250919: "continues",
} as const satisfies Record<AnthropicContextEditType, "continues" | "pauses">;

/** The metadata key the Anthropic adapter reads a native tool's kind by. */
const NATIVE_TOOL_KIND_KEY = "__kind";

/** The native tool kind of `tool` when Anthropic runs it itself. */
const pausingToolKind = (tool: unknown): string | undefined => {
  const metadata: unknown = isRecord(tool) ? tool["metadata"] : undefined;
  const marker = isRecord(metadata) ? metadata[NATIVE_TOOL_KIND_KEY] : null;
  return Object.entries(ANTHROPIC_NATIVE_TOOLS).find(
    ([kind, runs]) => runs === "pauses" && marker === `anthropic.${kind}`,
  )?.[0];
};

/** The first context edit in `modelOptions` not known to keep the turn
 *  going. */
const pausingContextEdit = (modelOptions: unknown): string | undefined => {
  const config: unknown = isRecord(modelOptions)
    ? modelOptions["context_management"]
    : undefined;
  const edits: unknown = isRecord(config) ? config["edits"] : undefined;
  if (!Array.isArray(edits)) {
    return undefined;
  }
  for (const edit of edits) {
    const type: unknown = isRecord(edit) ? edit["type"] : undefined;
    const continues = Object.entries(ANTHROPIC_CONTEXT_EDITS).some(
      ([known, effect]) => known === type && effect === "continues",
    );
    if (!continues) {
      return typeof type === "string" ? type : "a context edit";
    }
  }
  return undefined;
};

/**
 * Fails a request to Anthropic that enables a server tool or compaction:
 * its turn could end with `pause_turn` or `compaction`, which Stella cannot
 * continue yet. Remove once it can, with the table's two entries.
 */
export const refuseTurnPausingRequest = (
  provider: TanStackAIProvider | undefined,
  options: Parameters<AnyTextAdapter["chatStream"]>[0],
): void => {
  if (provider !== "anthropic") {
    return;
  }
  const enabled =
    arrayOrEmpty(options.tools).map(pausingToolKind).find(Boolean) ??
    pausingContextEdit(options.modelOptions);
  if (enabled !== undefined) {
    panic(
      `The request enables ${enabled}, whose turns can end with pause_turn or compaction, which are not continued yet`,
    );
  }
};

/** The run error code of a provider stop the answer cannot stand on. */
export const PROVIDER_STOPPED_CODE = "provider_stopped";

type RunFinishedChunk = Extract<StreamChunk, { type: EventType.RUN_FINISHED }>;
type RunErrorChunk = Extract<StreamChunk, { type: EventType.RUN_ERROR }>;
type TerminalChunk = RunErrorChunk | RunFinishedChunk;

const STOP_REASON_KEY = "providerStopReason";

/** The stop reason an adapter put on `chunk`: absent (`undefined`) when it
 *  reported none, `null` when the stream ended without one. */
const reportedStopReason = (
  chunk: TerminalChunk,
): string | null | undefined => {
  const metadata: unknown = chunk.metadata;
  if (!isRecord(metadata) || !Object.hasOwn(metadata, STOP_REASON_KEY)) {
    return undefined;
  }
  const reason = metadata[STOP_REASON_KEY];
  return typeof reason === "string" ? reason : null;
};

/** `chunk`'s metadata without the stop reason, or none if nothing is left. */
const metadataWithoutStopReason = (
  chunk: TerminalChunk,
): Pick<TerminalChunk, "metadata"> => {
  const rest = Object.entries(chunk.metadata ?? {}).filter(
    ([key]) => key !== STOP_REASON_KEY,
  );
  return rest.length === 0 ? {} : { metadata: Object.fromEntries(rest) };
};

const sharedFields = (chunk: TerminalChunk) => ({
  ...metadataWithoutStopReason(chunk),
  ...(chunk.model === undefined ? {} : { model: chunk.model }),
  ...(chunk.timestamp === undefined ? {} : { timestamp: chunk.timestamp }),
  ...(chunk.usage === undefined ? {} : { usage: chunk.usage }),
});

const stoppedError = (
  chunk: TerminalChunk,
  code: string,
  message: string,
): RunErrorChunk => ({
  ...sharedFields(chunk),
  type: EventType.RUN_ERROR,
  message,
  code,
  error: { message, code },
});

/**
 * The terminal event `chunk` stands for once its stop reason is decided.
 * `unfinishedCode` is the run error code of an unfinished response.
 */
const decidedTerminal = ({
  answered,
  calledTools,
  chunk,
  leftCalls,
  outcome,
  reason,
  run,
  unfinishedCode,
}: {
  /** The step wrote text or reasoning the user sees. */
  answered: boolean;
  calledTools: boolean;
  chunk: TerminalChunk;
  /** The step called a tool, in either stream shape. */
  leftCalls: boolean;
  outcome: StopOutcome;
  reason: string | null;
  run: { runId: string; threadId: string } | undefined;
  unfinishedCode: string;
}): TerminalChunk => {
  const finished = (
    finishReason: NonNullable<RunFinishedChunk["finishReason"]>,
  ): RunFinishedChunk => {
    const runId = chunk.runId ?? run?.runId;
    const threadId = chunk.threadId ?? run?.threadId;
    if (runId === undefined || threadId === undefined) {
      return panic("A provider stop ended a run that never started");
    }
    return {
      ...sharedFields(chunk),
      type: EventType.RUN_FINISHED,
      runId,
      threadId,
      finishReason,
    };
  };
  const failed = (message: string): TerminalChunk => {
    // A failure the adapter already reported keeps the provider's detail.
    if (chunk.type === EventType.RUN_ERROR) {
      const { metadata: _reported, ...reported } = chunk;
      return { ...reported, ...metadataWithoutStopReason(chunk) };
    }
    return stoppedError(chunk, PROVIDER_STOPPED_CODE, message);
  };
  switch (outcome) {
    case "ended": {
      return finished(calledTools ? "tool_calls" : "stop");
    }
    case "length":
    case "content_filter": {
      return finished(outcome);
    }
    case "unfinished": {
      return stoppedError(
        chunk,
        unfinishedCode,
        `The provider stopped before the response finished (${reason ?? "no stop reason"}).`,
      );
    }
    case "failed": {
      return failed(
        `The provider ended the response with ${reason ?? "no stop reason"}.`,
      );
    }
    case "unrecognized": {
      // A reason the provider added since its SDK: the answer the user saw
      // stands, but a step that wrote nothing, or left calls to run, has no
      // answer to stand on, and a stop the adapter reported as a failure
      // (an incomplete response) stays one.
      if (!answered || leftCalls || chunk.type === EventType.RUN_ERROR) {
        return failed(
          "The provider ended the response with a stop reason it does not document.",
        );
      }
      const answer = finished("stop");
      return {
        ...answer,
        metadata: { ...answer.metadata, stopReason: UNRECOGNIZED_STOP_REASON },
      };
    }
    default: {
      outcome satisfies never;
      return panic(`Unhandled stop outcome: ${String(outcome)}`);
    }
  }
};

/** Whether `chunk` writes text or reasoning the user sees. */
const writesVisibleOutput = (chunk: StreamChunk): boolean =>
  (chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
    chunk.type === EventType.TEXT_MESSAGE_CHUNK ||
    chunk.type === EventType.REASONING_MESSAGE_CONTENT ||
    chunk.type === EventType.REASONING_MESSAGE_CHUNK) &&
  (chunk.delta ?? "").trim() !== "";

/**
 * Every terminal event that carries a provider stop reason, rewritten to
 * the outcome `provider`'s table gives it. A terminal event with no reason
 * (the adapter's own errors, a mock) passes through unchanged.
 *
 * @yields Every chunk of the run, with each stop reason decided.
 */
export const withDecidedStopReasons = async function* (
  chunks: AsyncIterable<StreamChunk>,
  {
    provider,
    unfinishedCode,
  }: { provider: TanStackAIProvider; unfinishedCode: string },
): AsyncIterable<StreamChunk> {
  let run: { runId: string; threadId: string } | undefined;
  let answered = false;
  let calledTools = false;
  let leftCalls = false;
  for await (const chunk of chunks) {
    if (chunk.type === EventType.RUN_STARTED) {
      run = { runId: chunk.runId, threadId: chunk.threadId };
    }
    if (chunk.type === EventType.TOOL_CALL_START) {
      calledTools = true;
    }
    // The shorthand shape never enters the thread as a call, but the model
    // still asked for one.
    leftCalls ||=
      chunk.type === EventType.TOOL_CALL_START ||
      chunk.type === EventType.TOOL_CALL_CHUNK;
    answered ||= writesVisibleOutput(chunk);
    if (
      chunk.type !== EventType.RUN_FINISHED &&
      chunk.type !== EventType.RUN_ERROR
    ) {
      yield chunk;
      continue;
    }
    const reason = reportedStopReason(chunk);
    if (reason === undefined) {
      yield chunk;
      continue;
    }
    const outcome = stopOutcomeOf(provider, reason);
    if (outcome === "unrecognized" && reason !== null) {
      reportUnrecognizedStopReason(provider, reason);
    }
    yield decidedTerminal({
      answered,
      calledTools,
      chunk,
      leftCalls,
      outcome,
      reason,
      run,
      unfinishedCode,
    });
  }
};
