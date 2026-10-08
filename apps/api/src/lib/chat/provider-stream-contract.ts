import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, ModelMessage, StreamChunk } from "@tanstack/ai";
import {
  toRunErrorPayload,
  toRunErrorRawEvent,
} from "@tanstack/ai/adapter-internals";
import { Result, panic } from "better-result";

import type { ReasoningProvenance, TanStackAIProvider } from "@stll/ai-catalog";
import { Temporal } from "@stll/time";

import { arrayOrEmpty } from "@/api/lib/array";
import {
  buildClosedTranscript,
  continuationThinkingFor,
} from "@/api/lib/chat/closed-transcript";
import type {
  ClosedTranscript,
  ContinuationThinking,
} from "@/api/lib/chat/closed-transcript";
import {
  refuseTurnPausingRequest,
  withDecidedStopReasons,
} from "@/api/lib/chat/provider-stop-reasons";
import { reasoningProvenanceForSignature } from "@/api/lib/chat/reasoning-provenance";
import { TOOL_CALL_STEP_METADATA_KEY } from "@/api/lib/chat/tool-call-step";
import { withUniqueToolCallIds } from "@/api/lib/chat/unique-tool-call-ids";
import type { ToolCallIdLedger } from "@/api/lib/chat/unique-tool-call-ids";
import { withModelPlaceholdersOmitted } from "@/api/lib/json-schema/null-optionals";
import { isRecord } from "@/api/lib/type-guards";

// One owner for what every provider adapter's stream promises the rest of
// the service: it ends in exactly one terminal event (`RUN_FINISHED` or
// `RUN_ERROR`), last, and never by throwing. Adapters differ at the edges:
// some end a stream that stopped early with no event at all, some throw after
// their `RUN_ERROR`, some throw instead of reporting. Every adapter the model
// factory builds goes through here, so a reader never meets those edges.

/** The code of the run error a stream that ended early reports. */
export const INCOMPLETE_STREAM_CODE = "stream_incomplete";

const isTerminal = (chunk: StreamChunk): boolean =>
  chunk.type === EventType.RUN_FINISHED || chunk.type === EventType.RUN_ERROR;

export const runError = (
  model: string,
  error: { code?: string | undefined; message: string },
  rawEvent?: unknown,
): StreamChunk => ({
  type: EventType.RUN_ERROR,
  model,
  timestamp: Temporal.Now.instant().epochMilliseconds,
  message: error.message,
  ...(error.code === undefined ? {} : { code: error.code }),
  ...(rawEvent === undefined ? {} : { rawEvent }),
  error: {
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
  },
});

type RunErrorChunk = Extract<StreamChunk, { type: EventType.RUN_ERROR }>;
type RunFinishedChunk = Extract<StreamChunk, { type: EventType.RUN_FINISHED }>;

/**
 * The run error code of a response the model stopped writing because it
 * reached the output ceiling the request set (Anthropic, Gemini).
 */
export const TRUNCATED_AT_OUTPUT_CEILING_CODE = "max_tokens";
/**
 * OpenAI's Responses adapter reports a response that ended incomplete with
 * this code, and the reason it ended as the message.
 */
const INCOMPLETE_RESPONSE_CODE = "incomplete";
const OUTPUT_CEILING_REASON = "max_output_tokens";

// These upstream variants use string-literal discriminants rather than
// EventType members. Named, checked literals keep Oxlint's exhaustiveness
// analysis aligned with the SDK union.
const CUSTOM_STREAM_CHUNK_TYPE = "CUSTOM" satisfies StreamChunk["type"];
const TOOL_CALL_END_STREAM_CHUNK_TYPE =
  "TOOL_CALL_END" satisfies StreamChunk["type"];
const TOOL_CALL_START_STREAM_CHUNK_TYPE =
  "TOOL_CALL_START" satisfies StreamChunk["type"];

const isOutputCeilingStop = (chunk: RunErrorChunk): boolean =>
  chunk.code === TRUNCATED_AT_OUTPUT_CEILING_CODE ||
  (chunk.code === INCOMPLETE_RESPONSE_CODE &&
    chunk.message === OUTPUT_CEILING_REASON);

/**
 * A response cut off at the output ceiling, read as a `length` finish.
 *
 * Several adapters report that stop as a `RUN_ERROR` by design, where they
 * report every other one as a `RUN_FINISHED`. The engine, middleware and
 * caller must agree that the run reached the ceiling rather than recording a
 * failure while keeping its partial text, so the stop is read as `length`
 * before anything else sees it. The adapters' own events are left as they
 * are: the pass keys on the event, not on who reported it, so an adapter that
 * already ends a ceiling stop with `RUN_FINISHED` passes through untouched.
 *
 * The finish is held until the stream ends. An adapter that reports the stop
 * and then finishes anyway (Gemini) has its closing events pass in order, and
 * its trailing `RUN_FINISHED` gives the finish the usage the stop lacked.
 *
 * @yields Every chunk of the run, with a ceiling stop read as `length`.
 */
export const readOutputCeilingStopAsLength = async function* (
  chunks: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  let runIdentity: { runId: string; threadId: string } | undefined;
  let held: RunFinishedChunk | undefined;
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case EventType.RUN_STARTED: {
        runIdentity = { runId: chunk.runId, threadId: chunk.threadId };
        break;
      }
      case EventType.RUN_ERROR: {
        if (
          held !== undefined ||
          runIdentity === undefined ||
          !isOutputCeilingStop(chunk)
        ) {
          break;
        }
        held = {
          type: EventType.RUN_FINISHED,
          finishReason: "length",
          runId: runIdentity.runId,
          threadId: runIdentity.threadId,
          ...(chunk.metadata === undefined ? {} : { metadata: chunk.metadata }),
          ...(chunk.model === undefined ? {} : { model: chunk.model }),
          ...(chunk.timestamp === undefined
            ? {}
            : { timestamp: chunk.timestamp }),
          ...(chunk.usage === undefined ? {} : { usage: chunk.usage }),
        };
        continue;
      }
      case EventType.RUN_FINISHED: {
        if (held === undefined) {
          break;
        }
        if (held.usage === undefined && chunk.usage !== undefined) {
          held = { ...held, usage: chunk.usage };
        }
        continue;
      }
      case EventType.TEXT_MESSAGE_START:
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_END:
      case TOOL_CALL_START_STREAM_CHUNK_TYPE:
      case EventType.TOOL_CALL_ARGS:
      case TOOL_CALL_END_STREAM_CHUNK_TYPE:
      case EventType.TOOL_CALL_RESULT:
      case EventType.STEP_STARTED:
      case EventType.STEP_FINISHED:
      case EventType.MESSAGES_SNAPSHOT:
      case EventType.STATE_SNAPSHOT:
      case EventType.STATE_DELTA:
      case CUSTOM_STREAM_CHUNK_TYPE:
      case EventType.REASONING_START:
      case EventType.REASONING_MESSAGE_START:
      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_END:
      case EventType.REASONING_END:
      case EventType.REASONING_ENCRYPTED_VALUE:
      case EventType.REASONING_MESSAGE_CHUNK:
      case EventType.TEXT_MESSAGE_CHUNK:
      case EventType.TOOL_CALL_CHUNK:
      case EventType.ACTIVITY_SNAPSHOT:
      case EventType.ACTIVITY_DELTA:
      case EventType.RAW:
      case EventType.SUBAGENT_STARTED:
      case EventType.SUBAGENT_FINISHED:
      case EventType.SUBAGENT_ERROR: {
        break;
      }
      default: {
        chunk satisfies never;
        panic(`Unhandled chunk: ${String(chunk)}`);
      }
    }
    yield chunk;
  }
  if (held !== undefined) {
    yield held;
  }
};

type ChatStreamOptions = Parameters<AnyTextAdapter["chatStream"]>[0];

// Each tool call's input as its tool declares it. A strict provider spells an
// optional field it is not setting as `null`, some routes fill an optional
// string with "", and a model on any provider may write either; where the
// field's own schema refuses the placeholder, it reads as omitted, so the
// input checked, stored and shown is the declared shape on every provider.
async function* withDeclaredToolInput(
  chunks: AsyncIterable<StreamChunk>,
  options: ChatStreamOptions,
): AsyncIterable<StreamChunk> {
  const schemas = new Map<string, unknown>();
  for (const tool of arrayOrEmpty(options.tools)) {
    const toolName: unknown = tool.name;
    if (typeof toolName === "string") {
      schemas.set(toolName, tool.inputSchema);
    }
  }
  const names = new Map<string, string>();
  /** The argument text each call streamed, for an end that carries none. */
  const argumentText = new Map<string, string>();
  for await (const chunk of chunks) {
    if (chunk.type === EventType.TOOL_CALL_START) {
      names.set(chunk.toolCallId, chunk.toolCallName);
    }
    if (chunk.type === EventType.TOOL_CALL_ARGS) {
      argumentText.set(
        chunk.toolCallId,
        (argumentText.get(chunk.toolCallId) ?? "") + chunk.delta,
      );
    }
    if (chunk.type !== EventType.TOOL_CALL_END) {
      yield chunk;
      continue;
    }
    // `input` is optional on the event, and some adapters (Bedrock) end a
    // call without parsing what it streamed.
    const input =
      chunk.input ?? parsedArguments(argumentText.get(chunk.toolCallId));
    argumentText.delete(chunk.toolCallId);
    if (input === undefined) {
      yield chunk;
      continue;
    }
    const endName: unknown = Reflect.get(chunk, "toolCallName");
    const name =
      typeof endName === "string" ? endName : names.get(chunk.toolCallId);
    const schema = name === undefined ? undefined : schemas.get(name);
    yield {
      ...chunk,
      input:
        schema === undefined
          ? input
          : withModelPlaceholdersOmitted(schema, input),
    };
  }
}

/** Streamed argument text as the object it spells, if it spells one. */
const parsedArguments = (text: string | undefined): unknown => {
  if (text === undefined || text.trim() === "") {
    return undefined;
  }
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isOk(parsed) &&
    typeof parsed.value === "object" &&
    parsed.value !== null
    ? parsed.value
    : undefined;
};

/**
 * Every tool call of one response stamped with the response's step: the id of
 * its first call, which the thread holds once. The engine keeps a call's
 * metadata on the call it records, and so do the page and persistence, so
 * the step reads the same live, stored and reloaded. Adapters read only the
 * metadata keys they own, so the key never reaches a provider's wire.
 *
 * @yields Each chunk of `chunks`, every call start naming its step.
 */
async function* withToolCallSteps(
  chunks: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  let step: string | undefined;
  for await (const chunk of chunks) {
    if (chunk.type !== EventType.TOOL_CALL_START) {
      yield chunk;
      continue;
    }
    step ??= chunk.toolCallId;
    yield {
      ...chunk,
      metadata: { ...chunk.metadata, [TOOL_CALL_STEP_METADATA_KEY]: step },
    };
  }
}

async function* withOneTerminalEvent(
  chunks: AsyncIterable<StreamChunk>,
  options: ChatStreamOptions,
): AsyncIterable<StreamChunk> {
  const signal = options.request?.signal ?? undefined;
  const iterator = chunks[Symbol.asyncIterator]();
  let ended = false;
  // Set once the adapter's stream has finished on its own, by ending or by
  // throwing; any other exit (the reader stopped early) closes it here.
  let settled = false;
  try {
    for (;;) {
      const step = await Result.tryPromise(async () => await iterator.next());
      if (Result.isError(step)) {
        settled = true;
        // A throw after the run ended, or once it was cancelled, adds nothing.
        const error = step.error.cause;
        if (!ended && signal?.aborted !== true) {
          yield runError(
            options.model,
            toRunErrorPayload(error, "The provider stream failed"),
            toRunErrorRawEvent(error),
          );
        }
        return;
      }
      if (step.value.done === true) {
        settled = true;
        break;
      }
      // Nothing follows the terminal event; the rest is still read, so the
      // adapter finishes its own stream.
      if (!ended) {
        yield step.value.value;
        ended = isTerminal(step.value.value);
      }
    }
  } finally {
    if (!settled) {
      const closed = await Result.tryPromise(
        async () => await iterator.return?.(),
      );
      // Best effort: the reader already stopped and the run has its outcome,
      // so a close that fails has no one left to tell.
      closed.match({ err: () => undefined, ok: () => undefined });
    }
  }
  // A cancelled run ends where the cancel left it; any other run that stops
  // before its terminal event did not finish.
  if (!ended && signal?.aborted !== true) {
    yield runError(options.model, {
      code: INCOMPLETE_STREAM_CODE,
      message: "The provider stream ended before the response finished.",
    });
  }
}

type StreamContract = {
  /** The adapter the contract wraps, never itself contracted. */
  adapter: AnyTextAdapter;
  /** The run's tool call ids; absent outside a chat run. */
  ledger: ToolCallIdLedger | undefined;
  provider: TanStackAIProvider | undefined;
  reasoning: Map<string, ReasoningProvenance>;
};

/** What each contracted adapter wraps, so a run can bind its ledger to the
 *  same contract instead of stacking a second one. */
const streamContracts = new WeakMap<AnyTextAdapter, StreamContract>();

type ClosedProviderRequest = Omit<ChatStreamOptions, "messages"> & {
  messages: ClosedTranscript;
};

const dispatchClosedRequest = (
  adapter: AnyTextAdapter,
  options: ClosedProviderRequest,
) => adapter.chatStream(options);

type ClosedStructuredRequest = Omit<
  Parameters<AnyTextAdapter["structuredOutput"]>[0],
  "chatOptions"
> & {
  chatOptions: ClosedProviderRequest;
};

const dispatchClosedStructuredRequest = (
  adapter: AnyTextAdapter,
  options: ClosedStructuredRequest,
) => adapter.structuredOutput(options);

type ClosedStructuredStreamOptions = {
  adapter: AnyTextAdapter;
  stream: NonNullable<AnyTextAdapter["structuredOutputStream"]>;
  options: ClosedStructuredRequest;
};
const dispatchClosedStructuredStream = ({
  adapter,
  stream,
  options,
}: ClosedStructuredStreamOptions) => stream.call(adapter, options);

type ProducedReasoningOptions = {
  chunks: AsyncIterable<StreamChunk>;
  provider: TanStackAIProvider;
  modelId: string;
  reasoning: Map<string, ReasoningProvenance>;
};

// Only provider output may establish the origin of reasoning created inside
// the SDK's tool loop. Historical signatures never populate this run ledger.
async function* withProducedReasoning({
  chunks,
  provider,
  modelId,
  reasoning,
}: ProducedReasoningOptions): AsyncIterable<StreamChunk> {
  for await (const chunk of chunks) {
    const signatures: unknown[] = [];
    if (chunk.type === EventType.STEP_FINISHED) {
      signatures.push(Reflect.get(chunk, "signature"));
    }
    if (chunk.type === EventType.REASONING_ENCRYPTED_VALUE) {
      signatures.push(chunk.encryptedValue);
    }
    if (
      chunk.type === EventType.TOOL_CALL_START ||
      chunk.type === "TOOL_CALL_END"
    ) {
      signatures.push(chunk.metadata?.["thoughtSignature"]);
    }
    for (const signature of signatures) {
      if (typeof signature !== "string" || signature === "") {
        continue;
      }
      const provenance = reasoningProvenanceForSignature({
        provider,
        modelId,
        signature,
      });
      if (provenance !== undefined) {
        reasoning.set(signature, provenance);
      }
    }
    yield chunk;
  }
}

/** Whether provider options ask an Anthropic model to think. */
const requestsThinking = (modelOptions: unknown): boolean => {
  if (!isRecord(modelOptions)) {
    return false;
  }
  const thinking = modelOptions["thinking"];
  return isRecord(thinking) && thinking["type"] !== "disabled";
};

const withContinuationThinking = (
  options: ClosedProviderRequest,
  decision: ContinuationThinking,
): ClosedProviderRequest => {
  switch (decision) {
    case "as-requested":
      return options;
    case "disabled":
      return {
        ...options,
        modelOptions: {
          ...(isRecord(options.modelOptions) ? options.modelOptions : {}),
          thinking: { type: "disabled" },
        },
      };
    default:
      decision satisfies never;
      return panic(`Unhandled continuation thinking: ${String(decision)}`);
  }
};

const contracted = (contract: StreamContract): AnyTextAdapter => {
  const { adapter, ledger, provider, reasoning } = contract;
  const decided = (chunks: AsyncIterable<StreamChunk>) =>
    provider === undefined
      ? chunks
      : withDecidedStopReasons(chunks, {
          provider,
          unfinishedCode: INCOMPLETE_STREAM_CODE,
        });
  const closeMessages = (
    requested: Pick<ChatStreamOptions, "messages" | "model">,
    activeReasoning: Map<string, ReasoningProvenance>,
  ): ClosedTranscript | undefined =>
    provider === undefined
      ? undefined
      : buildClosedTranscript({
          messages: requested.messages.map((message): ModelMessage => ({
            ...message,
            ...(message.thinking === undefined
              ? {}
              : {
                  thinking: message.thinking.map((item) => {
                    const provenance =
                      item.signature === undefined
                        ? undefined
                        : activeReasoning.get(item.signature);
                    return provenance === undefined
                      ? item
                      : { ...item, provenance };
                  }),
                }),
            ...(message.toolCalls === undefined
              ? {}
              : {
                  toolCalls: message.toolCalls.map((call) => {
                    const signature: unknown = isRecord(call.metadata)
                      ? call.metadata["thoughtSignature"]
                      : undefined;
                    const provenance =
                      typeof signature === "string"
                        ? activeReasoning.get(signature)
                        : undefined;
                    return provenance === undefined || !isRecord(call.metadata)
                      ? call
                      : {
                          ...call,
                          metadata: {
                            ...call.metadata,
                            reasoningProvenance: provenance,
                          },
                        };
                  }),
                }),
          })),
          target: { provider, modelId: requested.model },
        });
  const chatStream: AnyTextAdapter["chatStream"] = (requested) => {
    const closed = closeMessages(requested, reasoning);
    const options =
      closed === undefined
        ? requested
        : withContinuationThinking(
            { ...requested, messages: closed },
            provider === undefined
              ? "as-requested"
              : continuationThinkingFor({
                  transcript: closed,
                  target: { provider, modelId: requested.model },
                  thinkingRequested: requestsThinking(requested.modelOptions),
                }),
          );
    refuseTurnPausingRequest(provider, options);
    const dispatched =
      closed === undefined
        ? adapter.chatStream(requested)
        : dispatchClosedRequest(adapter, { ...options, messages: closed });
    const produced =
      provider === undefined
        ? dispatched
        : withProducedReasoning({
            chunks: dispatched,
            provider,
            modelId: requested.model,
            reasoning,
          });
    return withOneTerminalEvent(
      withDeclaredToolInput(
        readOutputCeilingStopAsLength(
          decided(
            withToolCallSteps(
              withUniqueToolCallIds(produced, {
                ledger,
                messages: options.messages,
              }),
            ),
          ),
        ),
        options,
      ),
      options,
    );
  };
  const structuredOutput: AnyTextAdapter["structuredOutput"] = (requested) => {
    const closed = closeMessages(requested.chatOptions, reasoning);
    return closed === undefined
      ? adapter.structuredOutput(requested)
      : dispatchClosedStructuredRequest(adapter, {
          ...requested,
          chatOptions: { ...requested.chatOptions, messages: closed },
        });
  };
  const rawStructuredStream = adapter.structuredOutputStream;
  const structuredOutputStream: AnyTextAdapter["structuredOutputStream"] =
    rawStructuredStream === undefined
      ? undefined
      : (requested) => {
          const closed = closeMessages(requested.chatOptions, reasoning);
          return closed === undefined
            ? rawStructuredStream.call(adapter, requested)
            : dispatchClosedStructuredStream({
                adapter,
                stream: rawStructuredStream,
                options: {
                  ...requested,
                  chatOptions: { ...requested.chatOptions, messages: closed },
                },
              });
        };
  const proxy = new Proxy(adapter, {
    get: (target, key) => {
      if (key === "chatStream") {
        return chatStream;
      }
      if (key === "structuredOutput") {
        return structuredOutput;
      }
      if (key === "structuredOutputStream") {
        return structuredOutputStream;
      }
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
  streamContracts.set(proxy, contract);
  return proxy;
};

/**
 * `adapter` with its chat stream held to the contract above. Every other
 * member is the adapter's own, its methods bound to it, so class state
 * (private fields included) keeps working. `provider` names the table the
 * adapter's stop reasons are decided by (`provider-stop-reasons.ts`); an
 * adapter that reports none (a mock) passes its terminal event through. A
 * request whose turn could pause, which no run can continue yet, is refused
 * before it is sent (`refuseTurnPausingRequest`), and reasoning another
 * provider signed is left out of it (`provider-bound-reasoning.ts`).
 *
 * The contract holds an adapter once: two layers would each rename a reused
 * tool call id on their own.
 */
export const withProviderStreamContract = (
  adapter: AnyTextAdapter,
  provider?: TanStackAIProvider,
): AnyTextAdapter => {
  if (streamContracts.has(adapter)) {
    panic("The adapter is already held to the provider stream contract");
  }
  return contracted({
    adapter,
    ledger: undefined,
    provider,
    reasoning: new Map(),
  });
};

/**
 * `adapter`, which the stream contract already holds, for one run of a
 * thread: every request of the run keeps its tool call ids clear of `ledger`
 * (`unique-tool-call-ids.ts`). The ledger lives in the contract, not in the
 * request, so it cannot reach a provider.
 */
export const withRunToolCallIds = (
  adapter: AnyTextAdapter,
  ledger: ToolCallIdLedger,
): AnyTextAdapter => {
  const contract = streamContracts.get(adapter);
  if (contract === undefined) {
    panic("A run's adapter must be held to the provider stream contract");
  }
  return contracted({
    adapter: contract.adapter,
    ledger,
    provider: contract.provider,
    reasoning: new Map(),
  });
};
