import {
  EventType,
  convertSchemaToJsonSchema,
  parsePartialJSON,
} from "@tanstack/ai";
import type {
  AnyTextAdapter,
  ModelMessage,
  RunErrorEvent,
  StructuredOutputPart,
  SystemPrompt,
} from "@tanstack/ai";
import type { OpenAITextProviderOptions } from "@tanstack/ai-openai";
import { Result, panic } from "better-result";
import * as v from "valibot";

import { getOutputTokenLimit } from "@stll/ai-catalog";
import type {
  ModelRole,
  ReasoningEffort,
  TanStackAIProvider,
} from "@stll/ai-catalog";
import { classifyFailure } from "@stll/errors";

import type {
  AIRequestServiceTier,
  CachingDecision,
  OrgAIConfig,
} from "@/api/lib/ai-config";
import {
  classifyAIError,
  type AIErrorKind,
  providerErrorBody,
  providerStatusCode,
} from "@/api/lib/ai-error";
import type { TanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { AIRequestPolicy } from "@/api/lib/chat/ai-data-policy";
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
  getManagedOpenRouterConfiguration,
  getManagedOpenRouterCredentialProvider,
  type ManagedOpenRouterCredential,
} from "@/api/lib/chat/openrouter-credential";
import {
  MANAGED_PROVIDER_UNAVAILABLE_CODE,
  checkManagedProviderAvailable,
  managedProviderUnavailable,
} from "@/api/lib/chat/provider-data-policy";
import { readOutputCeilingStopAsLength } from "@/api/lib/chat/provider-stream-contract";
import {
  finishReasonOf,
  generateChatObject,
  runFinishedOutcomeOf,
  streamChatChunks,
  streamChatObject,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type {
  PublicStreamChunk,
  StreamChatChunksOptions,
  TanStackTextFinishReason,
} from "@/api/lib/chat/tanstack-chat-runtime";
import { ProviderCallError } from "@/api/lib/errors/provider-call-error";
import {
  createProviderCallError,
  providerRequestIdFrom,
} from "@/api/lib/errors/provider-call-failure";
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
import {
  assertModelDispatchScope,
  type ModelDispatchScope,
} from "@/api/lib/rate-limit/model-dispatch-admission";
import { checkStructuredOutputBudget } from "@/api/lib/structured-output-budget";
import {
  joinLayeredSystemPrompt,
  promptCachingUsesBreakpoints,
  tanStackCacheControl,
} from "@/api/lib/tanstack-ai-caching";
import type { LayeredSystemPrompt } from "@/api/lib/tanstack-ai-caching";
import {
  getTanStackTextModelById,
  getTanStackTextModelForRole,
  getTanStackTextModelInfoById,
  getTanStackTextModelInfoForRole,
  isMockTextAdapter,
  mockAnswersForOrganization,
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
  resolveTextModel?:
    | ((
        options: Parameters<typeof resolveTanStackTextModel>[0],
      ) => ResolvedTanStackTextModel | Promise<ResolvedTanStackTextModel>)
    | undefined;
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
} & AIRequestPolicy &
  ModelDispatchScope;

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
    /** Explicit exception for a generative fallback or provider-path probe. */
    outputMode?: "generative" | undefined;
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

type ResolveTextModelOptions = {
  modelId?: string | undefined;
  orgAIConfig: OrgAIConfig | null | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  role: ModelRole;
} & AIRequestPolicy &
  ModelDispatchScope;

const CANCELLED_GENERATION_MESSAGE = "AI generation was cancelled";

// Classified as well as caused: the 502 is what the caller answers with, the
// classification is what a failure sink records for it.
const cancelledGenerationError = (): HandlerError =>
  classifyFailure(
    new HandlerError({
      status: 502,
      message: CANCELLED_GENERATION_MESSAGE,
      cause: new AIGenerationCancelledError({
        message: CANCELLED_GENERATION_MESSAGE,
      }),
    }),
    "generation_cancelled",
  );

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
  const model = await (options.resolveTextModel ?? resolveTanStackTextModel)(
    options,
  );
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

export const streamTanStackTextForRole = async function* (
  options: TanStackTextForRoleOptions,
): AsyncIterable<string> {
  const model = await (options.resolveTextModel ?? resolveTanStackTextModel)(
    options,
  );
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;

  yield* streamTanStackTextDeltas({
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
 * Text only: a truncated structured response is unusable however the caller
 * grades completeness, so structured-output methods remain untouched.
 */
const normalizeOutputCeilingTextStops = (
  adapter: AnyTextAdapter,
): AnyTextAdapter => ({
  ...adapter,
  chatStream: (options) =>
    readOutputCeilingStopAsLength(adapter.chatStream(options)),
});

/**
 * The adapter a text run must be dispatched through for its finish to be
 * readable: an output-ceiling stop arrives as a `RUN_ERROR` rather than a
 * `RUN_FINISHED` on more than one adapter, so a caller reading the run's
 * finish off the raw adapter would grade a truncated answer as a failure on
 * one provider and as a whole answer on the next. Every caller that grades a
 * finish goes through here.
 *
 * The rule is `readOutputCeilingStopAsLength`'s, which the model factory
 * already applies to every provider adapter; reading a stream through it
 * twice changes nothing, and this keeps an adapter the factory did not build
 * (the local mock model) graded the same way. A ceiling stop read as
 * `length` still fails `require-complete`, so a caller that demands a whole
 * answer rejects it either way.
 */
export const textAdapterWithNormalizedStops = (
  model: ResolvedTanStackTextModel,
): AnyTextAdapter => normalizeOutputCeilingTextStops(model.adapter);

/** Text collected from one chat run, plus the finish the run reported. */
export type TanStackTextRun = {
  finish: TextRunFinish;
  text: string;
};

/**
 * Run a text chat to completion and keep both halves of the answer: the
 * collected text and how the run ended. Collecting only the text drops the finish,
 * which leaves a caller unable to tell a whole answer from one cut at the
 * output ceiling — for a drafted document field that difference is the
 * difference between a value and a sentence ending mid-word.
 *
 * Unlike `generateTanStackTextForRole` this takes the assembled chat options,
 * so a run carrying tools (the skill loop) can be graded the same way. The
 * caller owns the model resolution and must dispatch through
 * {@link textAdapterWithNormalizedStops}.
 */
export const collectTanStackTextRun = async (
  options: StreamChatChunksOptions & { model: ResolvedTanStackTextModel },
): Promise<TanStackTextRun> => {
  // Assigned from the loop below; a property keeps the declared union instead
  // of narrowing to the initial branch.
  const run: { finish: TextRunFinish } = { finish: { kind: "unfinished" } };
  let text = "";

  const result = await Result.tryPromise(async () => {
    for await (const chunk of streamChatChunks(options)) {
      throwIfTanStackRunError(chunk, options.model);
      if (chunk.type === EventType.RUN_FINISHED) {
        // A tool loop runs several times inside one call; the last finish is
        // the one that produced the answer being returned.
        run.finish =
          runFinishedOutcomeOf(chunk) === "cancelled"
            ? { kind: "unfinished" }
            : { kind: "finished", reason: finishReasonOf(chunk) };
        continue;
      }
      if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
        text += chunk.delta;
      }
    }

    return { finish: run.finish, text };
  });
  if (Result.isError(result)) {
    throw withRecoveredProviderStatus({
      error: result.error.cause,
      model: options.model,
      abortSignal: options.abortController?.signal,
    });
  }
  return result.value;
};

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
    abortSignal: abortController?.signal,
    model,
    serviceTier,
    stream: (requestedServiceTier) =>
      streamChatChunks({
        adapter: textAdapterWithNormalizedStops(model),
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
  abortSignal?: AbortSignal | undefined;
  model: ResolvedTanStackTextModel;
  serviceTier: AIRequestServiceTier;
  run: (serviceTier: AIRequestServiceTier) => Promise<TResult>;
};

// The only exit a failed non-streaming run has, so it is where that run's
// provider status is recovered. The retry decision reads the recovered error
// too: a fallback the provider's own status justifies cannot be skipped for
// want of a status the message still carries. The standard-tier attempt
// answers through this same function (`isDeferredServiceTier("standard")` is
// false, so it takes the throw), which leaves both attempts recovered without
// a second exit to keep in step.
const withStandardServiceTierFallback = async <TResult>({
  abortSignal,
  model,
  serviceTier,
  run,
}: StandardServiceTierFallbackOptions<TResult>): Promise<TResult> => {
  try {
    return await run(serviceTier);
  } catch (error) {
    const recovered = withRecoveredProviderStatus({
      error,
      model,
      abortSignal,
    });
    if (
      !shouldRetryWithStandardServiceTier({
        error: recovered,
        model,
        serviceTier,
      })
    ) {
      throw recovered;
    }

    return await withStandardServiceTierFallback({
      abortSignal,
      model,
      run,
      serviceTier: "standard",
    });
  }
};

type StandardServiceTierStreamFallbackOptions<
  TChunk extends PublicStreamChunk,
  TResult,
> = {
  abortSignal?: AbortSignal | undefined;
  model: ResolvedTanStackTextModel;
  serviceTier: AIRequestServiceTier;
  stream: (serviceTier: AIRequestServiceTier) => AsyncIterable<TChunk>;
  onChunk: (chunk: TChunk) => TResult | undefined;
};

const iterateWithStandardServiceTierFallback = async function* <
  TChunk extends PublicStreamChunk,
  TResult,
>({
  abortSignal,
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
      throwIfTanStackRunError(chunk, model);
      const result = onChunk(chunk);
      if (result === undefined) {
        continue;
      }
      yielded = true;
      yield result;
    }
    return;
  } catch (error) {
    const recovered = withRecoveredProviderStatus({
      error,
      model,
      abortSignal,
    });
    if (
      yielded ||
      !shouldRetryWithStandardServiceTier({
        error: recovered,
        model,
        serviceTier,
      })
    ) {
      throw recovered;
    }
  }

  yield* iterateWithStandardServiceTierFallback({
    abortSignal,
    model,
    serviceTier: "standard",
    stream,
    onChunk,
  });
};

const throwIfTanStackRunError = (
  chunk: PublicStreamChunk,
  model: ResolvedTanStackTextModel,
): void => {
  if (chunk.type !== EventType.RUN_ERROR) {
    return;
  }
  throw tanStackRunError(chunk, model);
};

const tanStackRunError = (
  chunk: RunErrorEvent,
  model: ResolvedTanStackTextModel,
): ProviderCallError => {
  const error = createProviderCallError({
    model,
    status: chunk.code === MANAGED_PROVIDER_UNAVAILABLE_CODE ? 503 : 502,
    code: chunk.code,
    evidence: chunk.rawEvent ?? providerErrorBody(chunk.message),
  });
  return chunk.code === MANAGED_PROVIDER_UNAVAILABLE_CODE
    ? classifyFailure(error, "model_unavailable")
    : error;
};

type RecoveredProviderStatusOptions = {
  error: unknown;
  model: ResolvedTanStackTextModel;
  abortSignal?: AbortSignal | undefined;
};

const PROVIDER_OWNED_ERROR_KIND = {
  quota_exhausted: true,
  provider_billing: true,
  provider_credentials_rejected: true,
  model_unavailable: true,
  provider_unavailable: true,
  provider_stream_incomplete: true,
  loop_detected: false,
  empty_completion: false,
  unknown: false,
} as const satisfies Record<AIErrorKind, boolean>;

export const withRecoveredProviderStatus = ({
  error,
  model,
  abortSignal,
}: RecoveredProviderStatusOptions): unknown => {
  if (
    error instanceof ProviderCallError ||
    isAbortRejection({ error, signal: abortSignal })
  ) {
    return error;
  }
  if (!(error instanceof Error)) {
    return error;
  }
  if (hasManagedProviderUnavailableCode(error)) {
    return classifyFailure(
      createProviderCallError({
        model,
        status: 503,
        code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
        evidence: error,
      }),
      "model_unavailable",
    );
  }
  const body = providerErrorBody(error.message);
  const evidence =
    body === undefined
      ? error
      : { cause: body, requestId: providerRequestIdFrom(error) };
  const kind = classifyAIError(evidence);
  if (
    !hasProviderFailureInCauseChain(evidence) &&
    !PROVIDER_OWNED_ERROR_KIND[kind]
  ) {
    return error;
  }
  return createProviderCallError({
    model,
    status: kind === "unknown" ? 500 : 502,
    evidence,
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
  !hasManagedProviderUnavailableCode(error) &&
  isDeferredServiceTier(serviceTier) &&
  isRetryableServiceTierFallbackError(error);

// `chat({ outputSchema })` does not rethrow the adapter's error: it records
// the failure and throws `new Error(message, { cause: providerError })`, so
// the status and retry hints live one `cause` down. The streaming paths throw
// the provider error itself, and a body-only failure arrives inside the
// `HandlerError` `withRecoveredProviderStatus` built for it, whose own 502 is
// this service's, not the provider's. Walk the chain to the first link that
// carries a provider status, using the classifier's own reader so the status
// the retry is decided on is the status the failure is named by; the depth
// bound keeps a cyclic cause from hanging the request.
const MAX_CAUSE_DEPTH = 8;

const hasManagedProviderUnavailableCode = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!isRecord(current)) {
      return false;
    }
    if (current["code"] === MANAGED_PROVIDER_UNAVAILABLE_CODE) {
      return true;
    }
    current = current["cause"];
  }
  return false;
};

const hasProviderFailureInCauseChain = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!isRecord(current)) {
      return false;
    }
    if (
      current instanceof ProviderCallError ||
      providerStatusCode(current) !== null
    ) {
      return true;
    }
    current = current["cause"];
  }
  return false;
};

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

/**
 * A run error the provider's own answer does not account for.
 *
 * The streaming seam's `RUN_ERROR` carries the provider's message and nothing
 * else: the engine drops the status the adapter's exception held, so a flex or
 * batch tier that was merely unavailable reaches this predicate with nothing
 * to judge. That run still failed at the provider, which is the case the
 * deferred-tier fallback exists for, so it retries once on the standard tier.
 *
 * The classifier decides "unaccounted for", not the absence of a number: an
 * adapter can name a permanent answer through a provider-owned marker that
 * carries no status at all (a rejected key), and a named answer is the
 * provider's verdict however it was spelled.
 */
const isUnattributedRunError = (error: unknown): boolean =>
  error instanceof ProviderCallError &&
  error.status === 502 &&
  classifyAIError(error) === "unknown";

const isRetryableServiceTierFallbackError = (error: unknown): boolean => {
  const provider = providerErrorInCauseChain(error);
  if (provider === null) {
    return isUnattributedRunError(error);
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const structuredOutputProjectionOptions = ({
  mock,
  provider,
}: {
  mock: boolean;
  provider: string;
}): ProviderSafeJsonSchemaProjectionOptions =>
  providerSafeJsonSchemaOptionsForTanStackProvider(
    provider,
    mock ? "mock-structured-output" : "structured-output",
  );

type StructuredOutputWireJsonSchemaOptions = {
  /** Whether the local mock answers the request instead of `provider`. */
  mock: boolean;
  outputSchema: v.GenericSchema;
  provider: TanStackAIProvider;
};

/**
 * The JSON Schema a structured-output request actually sends. `@tanstack/ai`
 * runs this exact conversion on the schema handed to `chat`, so sizing a
 * request against anything else would drift from what the provider compiles.
 */
export const structuredOutputWireJsonSchema = ({
  mock,
  outputSchema,
  provider,
}: StructuredOutputWireJsonSchemaOptions): unknown =>
  convertSchemaToJsonSchema(
    toTanStackValibotSchema(
      outputSchema,
      structuredOutputProjectionOptions({ mock, provider }),
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
  if (isMockTextAdapter(model.adapter)) {
    return;
  }

  const budget = checkStructuredOutputBudget({
    provider: model.provider,
    modelId: model.modelId,
    schema: structuredOutputWireJsonSchema({
      mock: false,
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
  outputMode: _outputMode,
  outputSchema,
  ...options
}: GenerateTanStackObjectForRoleOptions<TSchema>): Promise<
  v.InferOutput<TSchema>
> => {
  const model = await (options.resolveTextModel ?? resolveTanStackTextModel)(
    options,
  );
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;
  guardStructuredOutputBudget({ model, outputSchema });
  const tanStackOutputSchema = toTanStackValibotSchema(
    outputSchema,
    structuredOutputProjectionOptions({
      mock: isMockTextAdapter(model.adapter),
      provider: model.provider,
    }),
  );

  const generated = await Result.tryPromise({
    try: async () =>
      await withStandardServiceTierFallback({
        abortSignal: abortController?.signal,
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
      }),
    catch: (error: unknown) => error,
  });
  if (Result.isError(generated)) {
    // A cancelled run ends without a structured result, and the SDK reports
    // that as a plain error rather than an abort. The caller's signal is what
    // tells the two apart, as for text generation.
    if (options.abortSignal?.aborted === true) {
      throw cancelledGenerationError();
    }
    throw generated.error;
  }

  return v.parse(outputSchema, generated.value);
};

export const streamTanStackObjectForRole = async function* <
  TSchema extends v.GenericSchema,
>({
  outputMode: _outputMode,
  outputSchema,
  ...options
}: GenerateTanStackObjectForRoleOptions<TSchema>): AsyncIterable<
  TanStackStructuredOutputEvent<v.InferOutput<TSchema>>
> {
  const model = await (options.resolveTextModel ?? resolveTanStackTextModel)(
    options,
  );
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;

  yield* streamTanStackStructuredOutput({
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

// The SDK's non-streaming adapter fallback emits only the error message.
// Preserve a configured refusal before its status and code are discarded.
const streamChatObjectWithManagedErrors = async function* (
  options: Parameters<typeof streamChatObject>[0],
) {
  if (options.adapter.structuredOutputStream) {
    yield* streamChatObject(options);
    return;
  }

  let failure: { error: unknown } | undefined;
  const structuredOutput = async (
    structuredOptions: Parameters<AnyTextAdapter["structuredOutput"]>[0],
  ) => {
    const result = await Result.tryPromise({
      try: async () =>
        await options.adapter.structuredOutput(structuredOptions),
      catch: (error) => error,
    });
    if (Result.isOk(result)) {
      return result.value;
    }
    if (hasManagedProviderUnavailableCode(result.error)) {
      failure = { error: result.error };
    }
    throw result.error;
  };
  const adapter = new Proxy(options.adapter, {
    get: (target, key) => {
      if (key === "structuredOutput") {
        return structuredOutput;
      }
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });

  for await (const chunk of streamChatObject({ ...options, adapter })) {
    if (chunk.type === EventType.RUN_ERROR && failure !== undefined) {
      throw failure.error;
    }
    yield chunk;
  }
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
    structuredOutputProjectionOptions({
      mock: isMockTextAdapter(model.adapter),
      provider: model.provider,
    }),
  );

  const stream = iterateWithStandardServiceTierFallback({
    abortSignal: abortController?.signal,
    model,
    serviceTier,
    stream: (requestedServiceTier) =>
      streamChatObjectWithManagedErrors({
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

export const resolveTanStackTextModel = async (
  options: ResolveTextModelOptions,
  credentials = getManagedOpenRouterCredentialProvider(),
): Promise<ResolvedTanStackTextModel> => {
  // Every inference path resolves its model here with the proof that its
  // action was admitted; the type requires the proof, this binds it to the
  // organization the model serves.
  assertModelDispatchScope(options);
  const {
    admission: _admission,
    modelId,
    organizationId,
    orgAIConfig,
    reasoningEffort,
    role,
    ...policy
  } = options;
  // Every inference path (chat, subagents, field generators, workflow
  // batches) resolves its model here, so this is the one seam where a
  // request is classified `ai` for the split latency SLO — a new AI
  // endpoint cannot forget to classify itself. No-op outside a request
  // scope (background workers).
  markAiRequest();

  let managedOpenRouterCredential: ManagedOpenRouterCredential | undefined;
  if (!orgAIConfig && !mockAnswersForOrganization(orgAIConfig)) {
    const info = modelId
      ? getTanStackTextModelInfoById(
          modelId,
          orgAIConfig,
          role,
          policy.dataClass,
        )
      : getTanStackTextModelInfoForRole(role, orgAIConfig, {
          organizationId,
          ...policy,
        });
    if (info.provider === "openrouter") {
      const availability = checkManagedProviderAvailable(
        info.provider,
        policy.dataClass,
      );
      if (Result.isError(availability)) {
        throw availability.error;
      }
      const configuration = getManagedOpenRouterConfiguration();
      const credential = await credentials.get();
      if (Result.isError(credential)) {
        throw credential.error;
      }
      if (configuration.type === "unavailable") {
        throw managedProviderUnavailable("openrouter");
      }
      managedOpenRouterCredential =
        configuration.type === "static"
          ? { type: "static", apiKey: credential.value }
          : {
              type: "federated",
              apiKey: credential.value,
              invalidate: () => credentials.invalidate(credential.value),
            };
    }
  }

  return modelId
    ? getTanStackTextModelById(modelId, orgAIConfig, {
        role,
        organizationId,
        reasoningEffort,
        managedOpenRouterCredential,
        ...policy,
      })
    : getTanStackTextModelForRole(role, orgAIConfig, {
        organizationId,
        managedOpenRouterCredential,
        ...policy,
      });
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

/**
 * The request's system prompt. A layered prompt (a chat turn's) is split at
 * its layer ends for a provider that caches at markers
 * (`PROVIDER_PROMPT_CACHING`): the static and organization layers each end in
 * a marker, and the per-user and per-turn tail carries none. Every other
 * provider, and every request with caching off, receives one string, the
 * layers joined. A plain prompt keeps its single end-of-prompt marker on
 * Anthropic.
 */
export const systemPromptsPatch = ({
  caching,
  model,
  system,
}: {
  caching: CachingDecision;
  model: ResolvedTanStackTextModel;
  system: string | LayeredSystemPrompt | undefined;
}): { systemPrompts?: SystemPrompt[] } => {
  if (system === undefined) {
    return {};
  }
  const joined =
    typeof system === "string" ? system : joinLayeredSystemPrompt(system);
  if (!joined) {
    return {};
  }

  const cacheControl = tanStackCacheControl(caching);
  if (!cacheControl) {
    return { systemPrompts: [joined] };
  }

  if (typeof system === "string") {
    return model.provider === "anthropic"
      ? {
          systemPrompts: [
            { content: system, metadata: { cache_control: cacheControl } },
          ],
        }
      : { systemPrompts: [joined] };
  }

  if (!promptCachingUsesBreakpoints(model)) {
    return { systemPrompts: [joined] };
  }

  // A provider rejects an empty text block, so an empty layer is left out,
  // and its marker with it.
  const marked = [system.static, system.organization]
    .filter((layer) => layer.length > 0)
    .map((layer): SystemPrompt => ({
      content: layer,
      metadata: { cache_control: cacheControl },
    }));
  return {
    systemPrompts: system.turn.length === 0 ? marked : [...marked, system.turn],
  };
};

/**
 * The request-level marker a layered request adds where the provider caches at
 * markers. It lands on the request's last block, so it moves forward with the
 * conversation: each request reads the prefix the request before it wrote,
 * which is what caches history and every tool-loop iteration.
 */
const conversationCacheControl = ({
  cacheConversation,
  caching,
  model,
}: {
  cacheConversation: boolean;
  caching: CachingDecision;
  model: ResolvedTanStackTextModel;
}) => {
  const cacheControl = tanStackCacheControl(caching);
  return cacheConversation &&
    cacheControl !== undefined &&
    promptCachingUsesBreakpoints(model)
    ? cacheControl
    : undefined;
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

/**
 * A chat turn's output allowance for one model call: the model's catalog
 * output limit, less what an Anthropic thinking budget reserves inside the
 * same `max_tokens`, so the request never asks for more than the model can
 * emit (`mergeGenerationOptions` adds the reservation back). `undefined` for a
 * model the catalog does not list, which leaves the allowance to the
 * provider's default instead of a guessed cap that could cut replies short.
 * A thinking budget at or above the limit leaves no request that fits it
 * (Anthropic needs `max_tokens` above the budget), so the smallest valid
 * request is sent and the misfit is logged; no offered model reaches it.
 */
export const chatTurnOutputTokens = (
  model: ResolvedTanStackTextModel,
): number | undefined => {
  const limit = getOutputTokenLimit(model.modelId);
  if (limit === undefined) {
    return undefined;
  }
  const reservation =
    model.provider === "anthropic"
      ? anthropicThinkingReservation(model.modelOptions.thinking)
      : 0;
  const allowance = limit - reservation;
  if (allowance > 0) {
    return allowance;
  }
  logger.warn("tanstack_ai.output_allowance_clamped", {
    "ai.model": model.modelId,
    "ai.output_limit": limit,
    "ai.provider": model.provider,
    "ai.thinking_reservation": reservation,
  });
  return 1;
};

export const mergeGenerationOptions = ({
  cacheConversation = false,
  caching,
  model,
  maxOutputTokens,
  serviceTier,
  temperature,
}: {
  /**
   * The request carries a layered system prompt (a chat turn), so a provider
   * that caches at markers gets the request-level marker too.
   */
  cacheConversation?: boolean | undefined;
  caching: CachingDecision;
  model: ResolvedTanStackTextModel;
  maxOutputTokens: number | undefined;
  serviceTier: AIRequestServiceTier;
  temperature: number | undefined;
}): TanStackModelOptions => {
  const conversationMarker = conversationCacheControl({
    cacheConversation,
    caching,
    model,
  });
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
      return {
        ...anthropicOptions,
        ...temperatureOverride,
        ...(conversationMarker === undefined
          ? {}
          : { cache_control: conversationMarker }),
      };
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
        ...(conversationMarker === undefined
          ? {}
          : { cacheControl: conversationMarker }),
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
