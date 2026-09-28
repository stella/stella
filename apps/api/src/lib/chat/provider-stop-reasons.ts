import type Anthropic from "@anthropic-ai/sdk";
import type { StopReason as BedrockStopReason } from "@aws-sdk/client-bedrock-runtime";
import type { FinishReason as GeminiFinishReason } from "@google/genai";
import type { CompletionResponseStreamChoiceFinishReason as MistralFinishReasons } from "@mistralai/mistralai/models/components";
import type { ChatFinishReasonEnum as OpenRouterFinishReasons } from "@openrouter/sdk/models";
import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import type OpenAI from "openai";

import type { TanStackAIProvider } from "@stll/ai-catalog";

import { isRecord } from "@/api/lib/type-guards";

// What a provider's stated reason for ending a response means for the run.
// Each adapter reports the reason on its terminal event
// (`metadata.providerStopReason`, added by the adapter patches), and the
// decision lives here, in one table per provider keyed by the provider SDK's
// own union. A reason an SDK upgrade adds fails the typecheck until it has an
// outcome, so no reason reads as a finished answer by default.

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
   *  tool call, an unsupported language, an unknown reason). */
  | "failed";

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
  // request is sent again.
  pause_turn: "unfinished",
  // The context was compacted mid-turn; the turn continues only when the
  // request is sent again.
  compaction: "unfinished",
} as const satisfies Record<AnthropicStopReason, StopOutcome>;

const GOOGLE = {
  STOP: "ended",
  MAX_TOKENS: "length",
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
 *  without one, and a reason the SDK does not know is not a success. */
const stopOutcomeOf = (
  provider: TanStackAIProvider,
  reason: string | null,
): StopOutcome => {
  if (reason === null) {
    return "unfinished";
  }
  const table = PROVIDER_STOP_REASONS[provider];
  return Object.hasOwn(table, reason) ? (table[reason] ?? "failed") : "failed";
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
  calledTools,
  chunk,
  outcome,
  reason,
  run,
  unfinishedCode,
}: {
  calledTools: boolean;
  chunk: TerminalChunk;
  outcome: StopOutcome;
  reason: string | null;
  run: { runId: string; threadId: string } | undefined;
  unfinishedCode: string;
}): TerminalChunk => {
  const finished = (
    finishReason: NonNullable<RunFinishedChunk["finishReason"]>,
  ): TerminalChunk => {
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
      // A failure the adapter already reported keeps the provider's detail.
      if (chunk.type === EventType.RUN_ERROR) {
        const { metadata: _reported, ...reported } = chunk;
        return { ...reported, ...metadataWithoutStopReason(chunk) };
      }
      return stoppedError(
        chunk,
        PROVIDER_STOPPED_CODE,
        `The provider ended the response with ${reason ?? "no stop reason"}.`,
      );
    }
    default: {
      outcome satisfies never;
      return panic(`Unhandled stop outcome: ${String(outcome)}`);
    }
  }
};

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
  let calledTools = false;
  for await (const chunk of chunks) {
    if (chunk.type === EventType.RUN_STARTED) {
      run = { runId: chunk.runId, threadId: chunk.threadId };
    }
    if (chunk.type === EventType.TOOL_CALL_START) {
      calledTools = true;
    }
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
    yield decidedTerminal({
      calledTools,
      chunk,
      outcome: stopOutcomeOf(provider, reason),
      reason,
      run,
      unfinishedCode,
    });
  }
};
