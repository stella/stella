import {
  EventType,
  convertSchemaToJsonSchema,
  parsePartialJSON,
} from "@tanstack/ai";
import type {
  AnyTextAdapter,
  ModelMessage,
  RunErrorEvent,
  StreamChunk,
  StructuredOutputPart,
  SystemPrompt,
} from "@tanstack/ai";
import type { OpenAITextProviderOptions } from "@tanstack/ai-openai";
import { Result, panic } from "better-result";
import * as v from "valibot";

import type {
  ModelRole,
  ReasoningEffort,
  TanStackAIProvider,
} from "@stll/ai-catalog";

import type {
  AIRequestServiceTier,
  CachingDecision,
  OrgAIConfig,
} from "@/api/lib/ai-config";
import { providerErrorBody } from "@/api/lib/ai-error";
import type { TanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import {
  guardModelMessages,
  guardModelSystemPrompt,
  redactModelSystemPrompt,
} from "@/api/lib/chat/model-ingress-guard";
import type {
  GuardedModelMessages,
  GuardedSystemPrompt,
} from "@/api/lib/chat/model-ingress-guard";
import {
  finishReasonOf,
  generateChatObject,
  streamChatChunks,
  streamChatObject,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type {
  PublicStreamChunk,
  TanStackTextFinishReason,
} from "@/api/lib/chat/tanstack-chat-runtime";
import {
  AIGenerationCancelledError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { markAiRequest } from "@/api/lib/observability/request-context";
import {
  providerSafeJsonSchemaOptionsForTanStackProvider,
  type ProviderSafeJsonSchemaProjectionOptions,
} from "@/api/lib/provider-safe-json-schema";
import { checkStructuredOutputBudget } from "@/api/lib/structured-output-budget";
import { tanStackCacheControl } from "@/api/lib/tanstack-ai-caching";
import {
  getTanStackTextModelById,
  getTanStackTextModelForRole,
  isMockTextAdapterActive,
} from "@/api/lib/tanstack-ai-models";
import type {
  ResolvedTanStackTextModel,
  TanStackModelOptions,
} from "@/api/lib/tanstack-ai-models";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";

type GenerateTanStackInputOptions =
  | {
      messages: ModelMessage[];
      prompt?: never;
    }
  | {
      messages?: never;
      prompt: string;
    };

/**
 * How much of the system prompt this caller authored. Fully server-built
 * prompts fail closed on a tenant id (a hit is a Stella bug); prompts that
 * interpolate document text, model output, or other untrusted content are
 * redacted and reported, because a hit there is a user pasting a workspace
 * URL, not a bug worth a 500.
 */
type SystemPromptOrigin = "server-built" | "embeds-untrusted";

type GenerateTanStackBaseOptions = {
  abortSignal?: AbortSignal | undefined;
  analytics?: TanStackAIAnalyticsCallbacks | undefined;
  caching: CachingDecision;
  maxOutputTokens?: number | undefined;
  modelId?: string | undefined;
  /** External model-resolution boundary; supplied by focused integration tests. */
  resolveTextModel?: typeof resolveTanStackTextModel | undefined;
  organizationId: SafeId<"organization"> | null;
  orgAIConfig: OrgAIConfig | null | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  role: ModelRole;
  serviceTier: AIRequestServiceTier;
  system?: string | undefined;
  systemPromptOrigin?: SystemPromptOrigin | undefined;
  /**
   * The tenant workspace ids whose raw form must not reach the provider. Every
   * caller states its set (`[]` where the call carries no tenant scope at all,
   * e.g. public-corpus jobs) so the model-ingress guard runs on every request
   * this module dispatches, not only the ones someone remembered to guard.
   */
  tenantWorkspaceIds: readonly SafeId<"workspace">[];
  temperature?: number | undefined;
};

type TanStackTextForRoleOptions = GenerateTanStackBaseOptions &
  GenerateTanStackInputOptions;

/**
 * Which finish a caller accepts as an answer. `require-complete` rejects
 * everything but `stop`. `allow-output-ceiling` also accepts `length`, the
 * finish a run reports when it spends the whole `maxOutputTokens` budget, and
 * still rejects a moderated (`content_filter`), tool-bearing, or unfinished
 * run. `allow-incomplete` returns whatever text arrived.
 */
export type TanStackTextFinishPolicy =
  | "allow-incomplete"
  | "allow-output-ceiling"
  | "require-complete";

type GenerateTanStackTextForRoleOptions = TanStackTextForRoleOptions & {
  finishPolicy: TanStackTextFinishPolicy;
};

type GenerateTanStackObjectForRoleOptions<TSchema extends v.GenericSchema> =
  TanStackTextForRoleOptions & {
    outputSchema: TSchema;
  };

export type TanStackStructuredOutputPartial<TOutput> = NonNullable<
  StructuredOutputPart<TOutput>["partial"]
>;

export type TanStackStructuredOutputEvent<TOutput> =
  | {
      delta: string;
      type: "delta";
    }
  | {
      delta: string;
      partial: TanStackStructuredOutputPartial<TOutput>;
      raw: string;
      type: "partial";
    }
  | {
      object: TOutput;
      raw: string;
      reasoning?: string | undefined;
      type: "complete";
    };

type ResolveTextModelOptions = Pick<
  GenerateTanStackBaseOptions,
  "modelId" | "organizationId" | "orgAIConfig" | "reasoningEffort" | "role"
>;

const CANCELLED_GENERATION_MESSAGE = "AI generation was cancelled";

const cancelledGenerationError = (): HandlerError =>
  new HandlerError({
    status: 502,
    message: CANCELLED_GENERATION_MESSAGE,
    cause: new AIGenerationCancelledError({
      message: CANCELLED_GENERATION_MESSAGE,
    }),
  });

const isAbortRejection = ({
  error,
  signal,
}: {
  error: unknown;
  signal: AbortSignal | undefined;
}): boolean =>
  signal?.aborted === true &&
  (error === signal.reason ||
    (error instanceof Error && error.name === "AbortError"));

// How a text run ended, as the chat loop reported it. `unfinished` is a
// stream that closed without a `RUN_FINISHED` at all (a cancellation, or a
// lifecycle regression); `finished` carries the provider's reason, which the
// event leaves optional, so `null` there means the provider reported none.
type TextRunFinish =
  | { kind: "finished"; reason: TanStackTextFinishReason }
  | { kind: "unfinished" };

const finishAccepted = (
  finishPolicy: TanStackTextFinishPolicy,
  finish: TextRunFinish,
): boolean => {
  switch (finishPolicy) {
    case "allow-incomplete":
      return true;
    case "allow-output-ceiling":
      return (
        finish.kind === "finished" &&
        (finish.reason === "stop" || finish.reason === "length")
      );
    case "require-complete":
      return finish.kind === "finished" && finish.reason === "stop";
    default:
      finishPolicy satisfies never;
      return panic(`Unhandled finish policy: ${String(finishPolicy)}`);
  }
};

export const generateTanStackTextForRole = async (
  options: GenerateTanStackTextForRoleOptions,
): Promise<string> => {
  const model = (options.resolveTextModel ?? resolveTanStackTextModel)(options);
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;
  // Assigned from the stream callback, which control-flow analysis cannot
  // see; a property keeps the declared union instead of the initial branch.
  const run: { finish: TextRunFinish } = { finish: { kind: "unfinished" } };
  let output = "";

  try {
    for await (const delta of streamTanStackTextDeltas({
      abortController,
      analytics: options.analytics,
      caching: options.caching,
      maxOutputTokens: options.maxOutputTokens,
      messages: requestMessages,
      model,
      serviceTier: options.serviceTier,
      system: guardedSystemPrompt(options),
      temperature: options.temperature,
      onFinishReason: (reason) => {
        run.finish = { kind: "finished", reason };
      },
    })) {
      output += delta;
    }
  } catch (error) {
    if (isAbortRejection({ error, signal: options.abortSignal })) {
      throw cancelledGenerationError();
    }

    throw error;
  }

  // A cancelled run leaves the chat loop through a plain `break` on the next
  // chunk: no `RUN_FINISHED`, nothing thrown. Whether a cancellation instead
  // surfaces as an adapter rejection races the provider stream, so without
  // this the same cancellation is sometimes an error and sometimes a truncated
  // answer the caller cannot tell from a whole one. A reported finish
  // separates the two: that run completed before the signal fired.
  if (
    run.finish.kind === "unfinished" &&
    options.abortSignal?.aborted === true
  ) {
    throw cancelledGenerationError();
  }

  if (!finishAccepted(options.finishPolicy, run.finish)) {
    throw new HandlerError({
      status: 502,
      message: "AI generation did not complete",
    });
  }

  return output;
};

export const streamTanStackTextForRole = (
  options: TanStackTextForRoleOptions,
): AsyncIterable<string> => {
  const model = (options.resolveTextModel ?? resolveTanStackTextModel)(options);
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;

  return streamTanStackTextDeltas({
    abortController,
    analytics: options.analytics,
    caching: options.caching,
    maxOutputTokens: options.maxOutputTokens,
    messages: requestMessages,
    model,
    serviceTier: options.serviceTier,
    system: guardedSystemPrompt(options),
    temperature: options.temperature,
  });
};

/**
 * The provider code for a response the model stopped writing because it
 * reached the output ceiling the request set.
 *
 * The Anthropic adapter reports that stop reason as a `RUN_ERROR`, where it
 * reports every other one as a `RUN_FINISHED`. Normalize it before TanStack's
 * chat engine sees the event: the engine, middleware, and caller must agree
 * that the same run reached a `length` finish rather than recording a failure
 * while returning its partial text.
 */
const TRUNCATED_AT_OUTPUT_CEILING_CODE = "max_tokens";
// These upstream variants use string-literal discriminants rather than
// EventType members. Named, checked literals keep Oxlint's exhaustiveness
// analysis aligned with the SDK union.
const CUSTOM_STREAM_CHUNK_TYPE = "CUSTOM" satisfies StreamChunk["type"];
const TOOL_CALL_END_STREAM_CHUNK_TYPE =
  "TOOL_CALL_END" satisfies StreamChunk["type"];
const TOOL_CALL_START_STREAM_CHUNK_TYPE =
  "TOOL_CALL_START" satisfies StreamChunk["type"];

const readOutputCeilingStopAsLength = async function* (
  chunks: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  let runIdentity: { runId: string; threadId: string } | undefined;

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case EventType.RUN_STARTED: {
        runIdentity = { runId: chunk.runId, threadId: chunk.threadId };
        break;
      }
      case EventType.RUN_ERROR: {
        if (
          chunk.code !== TRUNCATED_AT_OUTPUT_CEILING_CODE ||
          runIdentity === undefined
        ) {
          break;
        }
        yield {
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
      case EventType.RUN_FINISHED:
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
      case EventType.REASONING_ENCRYPTED_VALUE: {
        break;
      }
      default: {
        chunk satisfies never;
        panic(`Unhandled chunk: ${String(chunk)}`);
      }
    }
    yield chunk;
  }
};

/**
 * Text only: a truncated structured response is unusable however the caller
 * grades completeness, so structured-output methods remain untouched.
 */
const normalizeAnthropicTextStops = (
  adapter: AnyTextAdapter,
): AnyTextAdapter => ({
  ...adapter,
  chatStream: (options) =>
    readOutputCeilingStopAsLength(adapter.chatStream(options)),
});

const streamTanStackTextDeltas = async function* ({
  abortController,
  analytics,
  caching,
  maxOutputTokens,
  messages,
  model,
  serviceTier,
  system,
  temperature,
  onFinishReason,
}: {
  abortController: AbortController | undefined;
  analytics: TanStackAIAnalyticsCallbacks | undefined;
  caching: CachingDecision;
  maxOutputTokens: number | undefined;
  messages: GuardedModelMessages<ModelMessage[]>;
  model: ResolvedTanStackTextModel;
  serviceTier: AIRequestServiceTier;
  system: GuardedSystemPrompt | undefined;
  temperature: number | undefined;
  onFinishReason?: ((reason: TanStackTextFinishReason) => void) | undefined;
}): AsyncIterable<string> {
  yield* iterateWithStandardServiceTierFallback({
    model,
    serviceTier,
    stream: (requestedServiceTier) =>
      streamChatChunks({
        adapter:
          model.provider === "anthropic"
            ? normalizeAnthropicTextStops(model.adapter)
            : model.adapter,
        messages,
        ...systemPromptsPatch({ caching, model, system }),
        modelOptions: mergeGenerationOptions({
          caching,
          model,
          maxOutputTokens,
          serviceTier: requestedServiceTier,
          temperature,
        }),
        ...(analytics ? { middleware: [analytics.middleware] } : {}),
        ...(abortController ? { abortController } : {}),
      }),
    onChunk: (chunk) => {
      if (chunk.type === EventType.RUN_FINISHED) {
        onFinishReason?.(finishReasonOf(chunk));
        return undefined;
      }
      if (
        chunk.type === EventType.TEXT_MESSAGE_CONTENT &&
        chunk.delta.length > 0
      ) {
        return chunk.delta;
      }
      return undefined;
    },
  });
};

type StandardServiceTierFallbackOptions<TResult> = {
  model: ResolvedTanStackTextModel;
  serviceTier: AIRequestServiceTier;
  run: (serviceTier: AIRequestServiceTier) => Promise<TResult>;
};

const withStandardServiceTierFallback = async <TResult>({
  model,
  serviceTier,
  run,
}: StandardServiceTierFallbackOptions<TResult>): Promise<TResult> => {
  try {
    return await run(serviceTier);
  } catch (error) {
    if (!shouldRetryWithStandardServiceTier({ error, model, serviceTier })) {
      throw error;
    }

    return await run("standard");
  }
};

type StandardServiceTierStreamFallbackOptions<
  TChunk extends PublicStreamChunk,
  TResult,
> = {
  model: ResolvedTanStackTextModel;
  serviceTier: AIRequestServiceTier;
  stream: (serviceTier: AIRequestServiceTier) => AsyncIterable<TChunk>;
  onChunk: (chunk: TChunk) => TResult | undefined;
};

const iterateWithStandardServiceTierFallback = async function* <
  TChunk extends PublicStreamChunk,
  TResult,
>({
  model,
  serviceTier,
  stream,
  onChunk,
}: StandardServiceTierStreamFallbackOptions<
  TChunk,
  TResult
>): AsyncIterable<TResult> {
  let yielded = false;

  try {
    for await (const chunk of stream(serviceTier)) {
      throwIfTanStackRunError(chunk);
      const result = onChunk(chunk);
      if (result === undefined) {
        continue;
      }
      yielded = true;
      yield result;
    }
    return;
  } catch (error) {
    if (
      yielded ||
      !shouldRetryWithStandardServiceTier({ error, model, serviceTier })
    ) {
      throw error;
    }
  }

  for await (const chunk of stream("standard")) {
    throwIfTanStackRunError(chunk);
    const result = onChunk(chunk);
    if (result !== undefined) {
      yield result;
    }
  }
};

const throwIfTanStackRunError = (chunk: PublicStreamChunk): void => {
  if (chunk.type !== EventType.RUN_ERROR) {
    return;
  }

  throw tanStackRunError(chunk);
};

// The classifier reads a wrapped provider failure off the cause, so the body
// has to survive the wrap. `rawEvent` carries it only for the adapters whose
// SDK exception exposes one; `providerErrorBody` recovers it from the message
// for the rest, which would otherwise reach the classifier with no status and
// be named a transient transport outage.
const tanStackRunError = (chunk: RunErrorEvent): HandlerError => {
  const cause: unknown = chunk.rawEvent ?? providerErrorBody(chunk.message);
  return new HandlerError({
    status: 502,
    message: chunk.message,
    ...(chunk.code ? { code: chunk.code } : {}),
    ...(cause === undefined ? {} : { cause }),
  });
};

const shouldRetryWithStandardServiceTier = ({
  error,
  model,
  serviceTier,
}: {
  error: unknown;
  model: ResolvedTanStackTextModel;
  serviceTier: AIRequestServiceTier;
}): boolean =>
  model.provider === "openai" &&
  isDeferredServiceTier(serviceTier) &&
  isRetryableServiceTierFallbackError(error);

// `chat({ outputSchema })` does not rethrow the adapter's error: it records
// the failure and throws `new Error(message, { cause: providerError })`, so
// the status and retry hints live one `cause` down. The streaming paths throw
// the provider error itself. Walk the chain to the first link that carries a
// provider status and judge that link; the depth bound keeps a cyclic cause
// from hanging the request.
const MAX_CAUSE_DEPTH = 8;

const providerErrorInCauseChain = (
  error: unknown,
): { record: Record<string, unknown>; statusCode: number } | null => {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!isRecord(current)) {
      return null;
    }
    const statusCode = providerStatusCode(current);
    if (statusCode !== null) {
      return { record: current, statusCode };
    }
    current = current["cause"];
  }
  return null;
};

const isRetryableServiceTierFallbackError = (error: unknown): boolean => {
  const provider = providerErrorInCauseChain(error);
  if (provider === null) {
    return false;
  }

  const isRetryable = provider.record["isRetryable"];
  if (isRetryable === false) {
    return false;
  }
  if (isRetryable === true) {
    return true;
  }

  return provider.statusCode === 429 || provider.statusCode >= 500;
};

const providerStatusCode = (error: Record<string, unknown>): number | null => {
  const statusCode = error["statusCode"];
  if (typeof statusCode === "number" && Number.isInteger(statusCode)) {
    return statusCode;
  }

  const status = error["status"];
  if (typeof status === "number" && Number.isInteger(status)) {
    return status;
  }

  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const structuredOutputProjectionOptions = (
  provider: string,
): ProviderSafeJsonSchemaProjectionOptions =>
  providerSafeJsonSchemaOptionsForTanStackProvider(
    provider,
    isMockTextAdapterActive() ? "mock-structured-output" : "structured-output",
  );

type StructuredOutputWireJsonSchemaOptions = {
  outputSchema: v.GenericSchema;
  provider: TanStackAIProvider;
};

/**
 * The JSON Schema a structured-output request actually sends. `@tanstack/ai`
 * runs this exact conversion on the schema handed to `chat`, so sizing a
 * request against anything else would drift from what the provider compiles.
 */
export const structuredOutputWireJsonSchema = ({
  outputSchema,
  provider,
}: StructuredOutputWireJsonSchemaOptions): unknown =>
  convertSchemaToJsonSchema(
    toTanStackValibotSchema(
      outputSchema,
      structuredOutputProjectionOptions(provider),
    ),
    { forStructuredOutput: true },
  );

/**
 * The one seam every structured-output request in this API passes through, so
 * a schema over the provider's grammar budget cannot reach a provider and come
 * back as an unrecoverable HTTP 400. Callers that can shrink their request
 * (the workflow batch splitter) size it before dispatch; this is the backstop
 * for the ones that cannot.
 */
const guardStructuredOutputBudget = ({
  model,
  outputSchema,
}: {
  model: ResolvedTanStackTextModel;
  outputSchema: v.GenericSchema;
}): void => {
  // The mock adapter answers locally: no provider compiles the grammar, and
  // its projection deliberately keeps keywords the wire schema drops.
  if (isMockTextAdapterActive()) {
    return;
  }

  const budget = checkStructuredOutputBudget({
    provider: model.provider,
    modelId: model.modelId,
    schema: structuredOutputWireJsonSchema({
      outputSchema,
      provider: model.provider,
    }),
  });
  if (Result.isError(budget)) {
    throw budget.error;
  }
};

export const generateTanStackObjectForRole = async <
  TSchema extends v.GenericSchema,
>({
  outputSchema,
  ...options
}: GenerateTanStackObjectForRoleOptions<TSchema>): Promise<
  v.InferOutput<TSchema>
> => {
  const model = (options.resolveTextModel ?? resolveTanStackTextModel)(options);
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;
  guardStructuredOutputBudget({ model, outputSchema });
  const tanStackOutputSchema = toTanStackValibotSchema(
    outputSchema,
    structuredOutputProjectionOptions(model.provider),
  );

  const output = await withStandardServiceTierFallback({
    model,
    serviceTier: options.serviceTier,
    run: async (serviceTier) =>
      await generateChatObject({
        adapter: model.adapter,
        messages: requestMessages,
        outputSchema: tanStackOutputSchema,
        ...systemPromptsPatch({
          caching: options.caching,
          model,
          system: guardedSystemPrompt(options),
        }),
        modelOptions: mergeGenerationOptions({
          caching: options.caching,
          model,
          maxOutputTokens: options.maxOutputTokens,
          serviceTier,
          temperature: options.temperature,
        }),
        ...(options.analytics
          ? { middleware: [options.analytics.middleware] }
          : {}),
        ...(abortController ? { abortController } : {}),
      }),
  });

  return v.parse(outputSchema, output);
};

export const streamTanStackObjectForRole = <TSchema extends v.GenericSchema>({
  outputSchema,
  ...options
}: GenerateTanStackObjectForRoleOptions<TSchema>): AsyncIterable<
  TanStackStructuredOutputEvent<v.InferOutput<TSchema>>
> => {
  const model = (options.resolveTextModel ?? resolveTanStackTextModel)(options);
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;

  return streamTanStackStructuredOutput({
    abortController,
    analytics: options.analytics,
    caching: options.caching,
    maxOutputTokens: options.maxOutputTokens,
    messages: requestMessages,
    model,
    outputSchema,
    serviceTier: options.serviceTier,
    system: guardedSystemPrompt(options),
    temperature: options.temperature,
  });
};

const streamTanStackStructuredOutput = async function* <
  TSchema extends v.GenericSchema,
>({
  abortController,
  analytics,
  caching,
  maxOutputTokens,
  messages,
  model,
  outputSchema,
  serviceTier,
  system,
  temperature,
}: {
  abortController: AbortController | undefined;
  analytics: TanStackAIAnalyticsCallbacks | undefined;
  caching: CachingDecision;
  maxOutputTokens: number | undefined;
  messages: GuardedModelMessages<ModelMessage[]>;
  model: ResolvedTanStackTextModel;
  outputSchema: TSchema;
  serviceTier: AIRequestServiceTier;
  system: GuardedSystemPrompt | undefined;
  temperature: number | undefined;
}): AsyncIterable<TanStackStructuredOutputEvent<v.InferOutput<TSchema>>> {
  let completed = false;
  let rawJson = "";
  guardStructuredOutputBudget({ model, outputSchema });
  const tanStackOutputSchema = toTanStackValibotSchema(
    outputSchema,
    structuredOutputProjectionOptions(model.provider),
  );

  const stream = iterateWithStandardServiceTierFallback({
    model,
    serviceTier,
    stream: (requestedServiceTier) =>
      streamChatObject({
        adapter: model.adapter,
        messages,
        outputSchema: tanStackOutputSchema,
        ...systemPromptsPatch({
          caching,
          model,
          system,
        }),
        modelOptions: mergeGenerationOptions({
          caching,
          model,
          maxOutputTokens,
          serviceTier: requestedServiceTier,
          temperature,
        }),
        ...(analytics ? { middleware: [analytics.middleware] } : {}),
        ...(abortController ? { abortController } : {}),
      }),
    onChunk: (chunk) => {
      if (
        chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
        (chunk.type === EventType.CUSTOM &&
          chunk.name === "structured-output.complete")
      ) {
        return chunk;
      }
      return undefined;
    },
  });

  for await (const chunk of stream) {
    if (
      chunk.type === EventType.TEXT_MESSAGE_CONTENT &&
      chunk.delta.length > 0
    ) {
      rawJson += chunk.delta;
      const partial =
        parseStructuredOutputPartial<v.InferOutput<TSchema>>(rawJson);
      if (partial !== undefined) {
        yield {
          type: "partial",
          delta: chunk.delta,
          partial,
          raw: rawJson,
        };
        continue;
      }

      yield { type: "delta", delta: chunk.delta };
      continue;
    }

    if (chunk.type !== EventType.CUSTOM) {
      continue;
    }

    completed = true;
    yield {
      type: "complete",
      object: v.parse(outputSchema, chunk.value.object),
      raw: chunk.value.raw,
      ...(chunk.value.reasoning === undefined
        ? {}
        : { reasoning: chunk.value.reasoning }),
    };
  }

  if (!completed) {
    throw new HandlerError({
      status: 502,
      message: "TanStack AI structured output stream ended before completion.",
    });
  }
};

const parseStructuredOutputPartial = <TOutput>(
  rawJson: string,
): TanStackStructuredOutputPartial<TOutput> | undefined => {
  const parsed: unknown = parsePartialJSON(rawJson);
  if (parsed === undefined || parsed === null) {
    return undefined;
  }

  if (!isStructuredOutputPartial<TOutput>(parsed)) {
    return undefined;
  }
  return parsed;
};

const isStructuredOutputPartial = <TOutput>(
  value: unknown,
): value is TanStackStructuredOutputPartial<TOutput> =>
  typeof value === "object" && value !== null;

export const resolveTanStackTextModel = ({
  modelId,
  organizationId,
  orgAIConfig,
  reasoningEffort,
  role,
}: ResolveTextModelOptions): ResolvedTanStackTextModel => {
  // Every inference path (chat, subagents, field generators, workflow
  // batches) resolves its model here, so this is the one seam where a
  // request is classified `ai` for the split latency SLO — a new AI
  // endpoint cannot forget to classify itself. No-op outside a request
  // scope (background workers).
  markAiRequest();

  return modelId
    ? getTanStackTextModelById(modelId, orgAIConfig, {
        role,
        organizationId,
        reasoningEffort,
      })
    : getTanStackTextModelForRole(role, orgAIConfig, { organizationId });
};

const messagesFromInput = (
  input: GenerateTanStackInputOptions,
): ModelMessage[] => {
  if ("messages" in input) {
    return input.messages;
  }
  return [{ role: "user", content: input.prompt }];
};

/**
 * The model-ingress seam for every non-chat model call: the dispatch helpers
 * below accept only guarded surfaces, so a new generation path cannot reach a
 * provider with unredacted tenant ids in its messages or system prompt.
 */
const guardedMessagesFromInput = (
  options: TanStackTextForRoleOptions,
): GuardedModelMessages<ModelMessage[]> =>
  guardModelMessages({
    messages: messagesFromInput(options),
    workspaceIds: options.tenantWorkspaceIds,
  });

const guardedSystemPrompt = ({
  system,
  systemPromptOrigin = "embeds-untrusted",
  tenantWorkspaceIds,
}: Pick<
  GenerateTanStackBaseOptions,
  "system" | "systemPromptOrigin" | "tenantWorkspaceIds"
>): GuardedSystemPrompt | undefined => {
  if (system === undefined) {
    return undefined;
  }
  return systemPromptOrigin === "server-built"
    ? guardModelSystemPrompt({ system, workspaceIds: tenantWorkspaceIds })
    : redactModelSystemPrompt({ system, workspaceIds: tenantWorkspaceIds });
};

export const abortControllerFromSignal = (
  signal: AbortSignal,
): AbortController => {
  const controller = new AbortController();
  const abort = () => {
    controller.abort(signal.reason);
  };
  if (signal.aborted) {
    abort();
    return controller;
  }
  signal.addEventListener("abort", abort, { once: true });
  return controller;
};

const PROVIDER_CACHE_KEY_MAX = 64;

const hashCacheScopeKey = (raw: string): string =>
  new Bun.CryptoHasher("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, PROVIDER_CACHE_KEY_MAX);

export const systemPromptsPatch = ({
  caching,
  model,
  system,
}: {
  caching: CachingDecision;
  model: ResolvedTanStackTextModel;
  system: string | undefined;
}): { systemPrompts?: SystemPrompt[] } => {
  if (!system) {
    return {};
  }

  if (model.provider !== "anthropic") {
    return { systemPrompts: [system] };
  }

  const cacheControl = tanStackCacheControl(caching);
  if (!cacheControl) {
    return { systemPrompts: [system] };
  }

  return {
    systemPrompts: [
      {
        content: system,
        metadata: { cache_control: cacheControl },
      },
    ],
  };
};

type AnthropicThinkingOption = Extract<
  ResolvedTanStackTextModel,
  { provider: "anthropic" }
>["modelOptions"]["thinking"];

/**
 * Extended-thinking tokens an Anthropic request must carry on top of its
 * output allowance.
 *
 * `max_tokens` bounds reasoning and visible output together, and the budget
 * form is only valid while `budget_tokens` stays below it. Callers size
 * `maxOutputTokens` for the reply alone, so the reservation is added to that
 * allowance instead of being taken out of it. The adaptive form reserves
 * nothing: it declares no budget, and the model sizes its own reasoning
 * inside `max_tokens`.
 */
const anthropicThinkingReservation = (
  thinking: AnthropicThinkingOption,
): number => {
  if (thinking?.type !== "enabled") {
    return 0;
  }
  // The SDK deprecates this field for newer adaptive-thinking models, but its
  // enabled branch still requires it for older models. Widen before checking
  // the external option shape so using that supported branch needs no waiver.
  const enabledThinking: object = thinking;
  if (
    !("budget_tokens" in enabledThinking) ||
    typeof enabledThinking["budget_tokens"] !== "number"
  ) {
    return panic("Enabled Anthropic thinking requires a numeric token budget");
  }
  return enabledThinking["budget_tokens"];
};

export const mergeGenerationOptions = ({
  caching,
  model,
  maxOutputTokens,
  serviceTier,
  temperature,
}: {
  caching: CachingDecision;
  model: ResolvedTanStackTextModel;
  maxOutputTokens: number | undefined;
  serviceTier: AIRequestServiceTier;
  temperature: number | undefined;
}): TanStackModelOptions => {
  // Caller temperature overrides only apply where the role builder
  // itself emitted a temperature. Builder omission is always
  // deliberate — the model rejects, deprecates, or ignores sampling
  // overrides (`MODEL_TEMPERATURE_POLICIES`), the id is uncatalogued, or the
  // role runs a thinking/reasoning mode that is incompatible with
  // temperature (Anthropic extended thinking rejects it even on
  // models that accept temperature otherwise). The suppression is
  // logged so a caller's explicit setting never disappears without a
  // trace.
  const builderEmittedTemperature = "temperature" in model.modelOptions;
  if (temperature !== undefined && !builderEmittedTemperature) {
    logger.debug("tanstack_ai.temperature_suppressed", {
      "ai.model": model.modelId,
      "ai.provider": model.provider,
    });
  }
  const temperatureOverride =
    temperature !== undefined && builderEmittedTemperature
      ? { temperature }
      : {};
  switch (model.provider) {
    case "google":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...temperatureOverride,
        ...googleServiceTierOptions(serviceTier),
      };
    case "anthropic": {
      const anthropicOptions = {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : {
              max_tokens:
                maxOutputTokens +
                anthropicThinkingReservation(model.modelOptions.thinking),
            }),
      };
      return { ...anthropicOptions, ...temperatureOverride };
    }
    case "bedrock":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : { max_completion_tokens: maxOutputTokens }),
        ...temperatureOverride,
      };
    case "mistral":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : { max_tokens: maxOutputTokens }),
        ...temperatureOverride,
      };
    case "openai":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: maxOutputTokens }),
        ...temperatureOverride,
        ...openAICacheOptions(caching),
        ...openAIServiceTierOptions(serviceTier),
      };
    case "openrouter":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : { maxCompletionTokens: maxOutputTokens }),
        ...temperatureOverride,
        ...openRouterServiceTierOptions(serviceTier),
      };
    default: {
      model satisfies never;
      return panic(`Unhandled model: ${String(model)}`);
    }
  }
};

const isDeferredServiceTier = (serviceTier: AIRequestServiceTier): boolean =>
  serviceTier === "flex" || serviceTier === "batch";

// `prompt_cache_retention` is omitted because no explicit value is valid across
// this catalogue: gpt-5.5 accepts only "24h", while OpenAI's extended-retention
// model list does not include gpt-5.4-mini or gpt-5.4-nano, so "24h" is not
// portable either. Omission takes the provider default, which also adapts to
// the org's data-retention posture: "24h" without ZDR, "in_memory" with it.
// Retention is a per-model capability (gpt-5.6+ replaces this field with
// `prompt_cache_options.ttl`), so a retention policy belongs in the model
// catalogue, not here.
const openAICacheOptions = (
  caching: CachingDecision,
): Partial<Pick<OpenAITextProviderOptions, "prompt_cache_key">> => {
  if (!caching.enabled || caching.scopeKey === null) {
    return {};
  }
  return {
    prompt_cache_key: hashCacheScopeKey(caching.scopeKey),
  };
};

const openAIServiceTierOptions = (
  serviceTier: AIRequestServiceTier,
): Pick<OpenAITextProviderOptions, "service_tier"> => ({
  service_tier: isDeferredServiceTier(serviceTier) ? "flex" : "default",
});

const openRouterServiceTierOptions = (
  serviceTier: AIRequestServiceTier,
): Pick<TanStackModelOptions<"openrouter">, "serviceTier"> => ({
  serviceTier: isDeferredServiceTier(serviceTier) ? "flex" : "default",
});

const googleServiceTierOptions = (
  serviceTier: AIRequestServiceTier,
): Pick<TanStackModelOptions<"google">, "serviceTier"> => ({
  serviceTier: isDeferredServiceTier(serviceTier) ? "flex" : "standard",
});
