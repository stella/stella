import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import {
  convertSchemaToJsonSchema,
  EventType,
  parsePartialJSON,
} from "@tanstack/ai";
import type {
  AnyTextAdapter,
  ModelMessage,
  RunErrorEvent,
  StructuredOutputPart,
  SystemPrompt,
  TokenUsage,
} from "@tanstack/ai";
import type { OpenAITextProviderOptions } from "@tanstack/ai-openai";
import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  getModelDefaultReasoningEffort,
  getOutputTokenLimit,
} from "@stll/ai-catalog";
import type {
  ModelTask,
  ReasoningEffort,
  TanStackAIProvider,
} from "@stll/ai-catalog";
import { sleep } from "@stll/concurrency/sleep";
import { TimeoutError, withTimeout } from "@stll/concurrency/with-timeout";
import { classifyFailure } from "@stll/errors";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import type {
  AIRequestServiceTier,
  CachingDecision,
  OrgAIConfig,
} from "@/api/lib/ai-config";
import {
  type AIErrorKind,
  classifyAIError,
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
import { OUTPUT_CEILING_OPTION } from "@/api/lib/chat/output-ceiling";
import {
  checkManagedProviderAvailable,
  MANAGED_PROVIDER_UNAVAILABLE_CODE,
  managedProviderUnavailable,
} from "@/api/lib/chat/provider-data-policy";
import { recordedStopReasonOf } from "@/api/lib/chat/provider-stop-reasons";
import { readOutputCeilingStopAsLength } from "@/api/lib/chat/provider-stream-contract";
import {
  finishReasonOf,
  generateChatObject,
  runFinishedOutcomeOf,
  streamChatChunks,
  streamChatObject,
} from "@/api/lib/chat/tanstack-chat-runtime";
import type {
  PublicRunFinishedChunk,
  PublicStreamChunk,
  StreamChatChunksOptions,
  TanStackTextFinishReason,
} from "@/api/lib/chat/tanstack-chat-runtime";
import {
  ModelDeadlineExceededError,
  ModelOutputIncompleteError,
  ModelOutputInvalidError,
  ModelOutputModeratedError,
  ModelRunError,
  ModelRunUnfinishedError,
  PROVIDER_CALL_ERROR_MESSAGE,
  ProviderCallError,
} from "@/api/lib/errors/provider-call-error";
import type { ModelRunFinish } from "@/api/lib/errors/provider-call-error";
import {
  createProviderCallError,
  providerRequestIdFrom,
} from "@/api/lib/errors/provider-call-failure";
import {
  PROVIDER_RETRY_WAIT_CAP_MS,
  providerRetryDelayMs,
} from "@/api/lib/errors/provider-retry-delay";
import {
  AIGenerationCancelledError,
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { markAiRequest } from "@/api/lib/observability/request-context";
import {
  providerSafeJsonSchemaOptionsForTanStackProvider,
  type ProviderSafeJsonSchemaProjectionOptions,
} from "@/api/lib/provider-safe-json-schema";
import {
  admittedDispatchSignal,
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
  getStructuredOutputFallbackModelId,
  getTanStackTextModelById,
  getTanStackTextModelForTask,
  getTanStackTextModelInfoById,
  getTanStackTextModelInfoForTask,
  isMockTextAdapter,
  mockAnswersForOrganization,
} from "@/api/lib/tanstack-ai-models";
import type {
  ResolvedTanStackTextModel,
  TanStackModelOptions,
} from "@/api/lib/tanstack-ai-models";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";
import { tokenUsageFromTerminalChunk } from "@/api/lib/tanstack-ai-usage";

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
  task: ModelTask;
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

type TanStackTextForTaskOptions = GenerateTanStackBaseOptions &
  GenerateTanStackInputOptions;

/**
 * Which finish a caller accepts as an answer. `require-complete` rejects
 * everything but `stop`. `allow-output-ceiling` also accepts `length`, the
 * finish a run reports when it spends the whole `maxOutputTokens` budget, and
 * still rejects a moderated (`content_filter`), tool-bearing, or unfinished
 * run. `allow-incomplete` returns whatever text arrived.
 */
export type TanStackTextFinishPolicy =
  "allow-incomplete" | "allow-output-ceiling" | "require-complete";

/**
 * A bound on one awaited model call, owned by the call rather than threaded in
 * as an abort signal: a run that outlives it fails as a
 * `ModelDeadlineExceededError`, never as the cancellation an abort signal
 * reads as, so the caller can tell a slow provider from a client that left.
 */
type GenerationDeadlineOption = {
  deadlineMs?: number | undefined;
};

type GenerateTanStackTextForTaskOptions = TanStackTextForTaskOptions &
  GenerationDeadlineOption & {
    finishPolicy: TanStackTextFinishPolicy;
  };

/**
 * The output a structured answer needs, in tokens. The request asks for this
 * much, bounded by what the resolved model can emit at all (its catalog output
 * limit, less any thinking reservation), so a caller states its own need once
 * and no model-specific number lives at a call site. Exclusive with
 * `maxOutputTokens`, which sends a figure as given.
 */
type OutputTokenBudgetOption =
  | { outputTokenBudget?: never }
  | { maxOutputTokens?: never; outputTokenBudget: number };

type GenerateTanStackObjectForTaskOptions<TSchema extends v.GenericSchema> =
  TanStackTextForTaskOptions &
    OutputTokenBudgetOption &
    Pick<StreamChatChunksOptions, "tools" | "agentLoopStrategy"> & {
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
  abortSignal?: AbortSignal | undefined;
  modelId?: string | undefined;
  orgAIConfig: OrgAIConfig | null | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  task: ModelTask;
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

const GENERATION_DEADLINE_LABEL = "model generation deadline";

/**
 * Bounds a whole generation, model resolution included, by its caller's
 * deadline. The run is raced rather than only signalled: a resolver or an
 * adapter that ignores cancellation still cannot hold the caller past the
 * deadline, which then settles as a `ModelDeadlineExceededError`. The run
 * also receives the deadline as an abort signal, so work that does listen
 * stops with it.
 */
export const withGenerationDeadline = async <T>(
  {
    abortSignal,
    deadlineMs,
  }: GenerationDeadlineOption & { abortSignal?: AbortSignal | undefined },
  run: (
    abortSignal: AbortSignal | undefined,
    /** When the deadline falls, on the `performance.now()` clock. */
    deadlineAt?: number,
  ) => Promise<T>,
): Promise<T> => {
  if (deadlineMs === undefined) {
    return await run(abortSignal);
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
    return panic("A generation deadline must be a positive integer of ms");
  }
  const deadlineAt = performance.now() + deadlineMs;
  const settled = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async (deadlineSignal) =>
          await run(
            abortSignal === undefined
              ? deadlineSignal
              : AbortSignal.any([abortSignal, deadlineSignal]),
            deadlineAt,
          ),
        { label: GENERATION_DEADLINE_LABEL, timeoutMs: deadlineMs },
      ),
    catch: (error: unknown) => error,
  });
  if (Result.isOk(settled)) {
    return settled.value;
  }
  if (
    TimeoutError.is(settled.error) &&
    settled.error.label === GENERATION_DEADLINE_LABEL
  ) {
    throw new ModelDeadlineExceededError({ deadlineMs });
  }
  throw settled.error;
};

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
  | {
      kind: "finished";
      reason: TanStackTextFinishReason;
      /** The provider's own stop reason, where its table lists it. */
      providerStopReason?: string | undefined;
    }
  | { kind: "unfinished" };

const finishedRunOf = (chunk: PublicRunFinishedChunk): TextRunFinish => {
  const providerStopReason = recordedStopReasonOf(chunk);
  return {
    kind: "finished",
    reason: finishReasonOf(chunk),
    ...(providerStopReason === undefined ? {} : { providerStopReason }),
  };
};

/** How a refused run ended, as its failure records it. */
const modelRunFinishOf = (finish: TextRunFinish): ModelRunFinish => {
  if (finish.kind === "unfinished") {
    return { finish: "unfinished" };
  }
  return {
    finish: finish.reason ?? "none",
    ...(finish.providerStopReason === undefined
      ? {}
      : { providerStopReason: finish.providerStopReason }),
  };
};

/**
 * The typed failure of a run its finish policy refused: an answer cut at its
 * output ceiling, one the provider filtered, or a run that ended without an
 * answer. Each carries the finish it ended with, so a sink records why.
 */
const refusedFinishError = (
  model: Pick<ResolvedTanStackTextModel, "provider" | "keySource">,
  finish: TextRunFinish,
): ModelRunError => {
  const options = { model, finish: modelRunFinishOf(finish) };
  if (finish.kind === "unfinished") {
    return new ModelRunUnfinishedError(options);
  }
  switch (finish.reason) {
    case "length":
      return new ModelOutputIncompleteError(options);
    case "content_filter":
      return new ModelOutputModeratedError(options);
    case "tool_calls":
    case null:
      return new ModelRunUnfinishedError(options);
    case "stop":
      return panic("A refused finish cannot be a clean stop");
    default:
      finish.reason satisfies never;
      return panic(`Unhandled finish reason: ${String(finish.reason)}`);
  }
};

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

/**
 * The provider's retry delay when a call failed for a rate limit or quota,
 * whether the failure is already a `ProviderCallError` or still the SDK's.
 */
const rateLimitRetryDelayMs = (error: unknown): number | undefined => {
  if (error instanceof ProviderCallError) {
    return error.kind === "quota_exhausted" ? error.retryAfterMs : undefined;
  }
  return classifyAIError(error) === "quota_exhausted"
    ? providerRetryDelayMs(error)
    : undefined;
};

/**
 * Wait out a short provider retry delay and try once more. A call refused
 * for a rate limit whose stated delay fits `PROVIDER_RETRY_WAIT_CAP_MS` runs
 * again after that delay; a longer delay, no stated delay, any other failure
 * and a second refusal all reach the caller unchanged, the delay still on the
 * error so the caller can say when to retry. A wait the call's deadline
 * cannot cover is not started: the refusal reaches the caller with its delay
 * rather than ending as a timeout that forgot it. The wait also honours the
 * abort signal.
 */
export const withProviderRetryWait = async <T>(
  abortSignal: AbortSignal | undefined,
  run: () => Promise<T>,
  deadlineAt?: number,
): Promise<T> => {
  const first = await Result.tryPromise({
    try: run,
    catch: (error: unknown) => error,
  });
  if (Result.isOk(first)) {
    return first.value;
  }
  const delay = rateLimitRetryDelayMs(first.error);
  if (
    delay === undefined ||
    delay > PROVIDER_RETRY_WAIT_CAP_MS ||
    (deadlineAt !== undefined && performance.now() + delay >= deadlineAt)
  ) {
    throw first.error;
  }
  const waited = await Result.tryPromise({
    try: async () =>
      await sleep(
        delay,
        abortSignal === undefined ? {} : { signal: abortSignal },
      ),
    catch: (error: unknown) => error,
  });
  if (Result.isError(waited)) {
    // A cancellation during the wait ends the run as one during the call
    // would; a deadline settles in `withGenerationDeadline` either way.
    if (isAbortRejection({ error: waited.error, signal: abortSignal })) {
      throw cancelledGenerationError();
    }
    throw waited.error;
  }
  return await run();
};

export const generateTanStackTextForTask = async (
  options: GenerateTanStackTextForTaskOptions,
): Promise<string> =>
  await withGenerationDeadline(
    options,
    async (abortSignal, deadlineAt) =>
      await withProviderRetryWait(
        abortSignal,
        async () =>
          await generateTanStackTextWithin({ ...options, abortSignal }),
        deadlineAt,
      ),
  );

const generateTanStackTextWithin = async (
  options: GenerateTanStackTextForTaskOptions,
): Promise<string> => {
  // Checked before the model resolves: a dispatch on a settled proof panics.
  const abortSignal = admittedDispatchSignal(options);
  const model = await (options.resolveTextModel ?? resolveTanStackTextModel)(
    options,
  );
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = abortSignal
    ? abortControllerFromSignal(abortSignal)
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
      onFinish: (finish) => {
        run.finish = finish;
      },
    })) {
      output += delta;
    }
  } catch (error) {
    if (isAbortRejection({ error, signal: abortSignal })) {
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
  if (run.finish.kind === "unfinished" && abortSignal?.aborted === true) {
    throw cancelledGenerationError();
  }

  if (!finishAccepted(options.finishPolicy, run.finish)) {
    throw refusedFinishError(model, run.finish);
  }

  return output;
};

export const streamTanStackTextForTask = async function* (
  options: TanStackTextForTaskOptions,
): AsyncIterable<string> {
  // Checked before the model resolves: a dispatch on a settled proof panics.
  const abortSignal = admittedDispatchSignal(options);
  const model = await (options.resolveTextModel ?? resolveTanStackTextModel)(
    options,
  );
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = abortSignal
    ? abortControllerFromSignal(abortSignal)
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
 * Unlike `generateTanStackTextForTask` this takes the assembled chat options,
 * so a run carrying tools (the skill loop) can be graded the same way. The
 * caller owns the model resolution and must dispatch through
 * {@link textAdapterWithNormalizedStops}.
 */
/**
 * The proof a direct chat run was admitted under. The run's abort follows the
 * admitted action, so model work never outlives the lease that admitted it.
 */
type AdmittedChatRunOptions = StreamChatChunksOptions & {
  model: ResolvedTanStackTextModel;
  admission: ModelDispatchScope["admission"];
  userId: ModelDispatchScope["userId"];
};

const admittedChatRunOptions = ({
  admission,
  userId,
  abortController,
  ...options
}: AdmittedChatRunOptions): StreamChatChunksOptions & {
  model: ResolvedTanStackTextModel;
} => {
  const controller = admittedAbortController({
    admission,
    userId,
    abortController,
  });
  return controller === undefined
    ? options
    : { ...options, abortController: controller };
};

const admittedAbortController = ({
  admission,
  userId,
  abortController,
}: Pick<AdmittedChatRunOptions, "admission" | "userId" | "abortController">):
  AbortController | undefined => {
  switch (admission.type) {
    case "organization": {
      // Checks the proof still admits work, then joins its signal.
      const signal = admittedDispatchSignal({
        organizationId: admission.organizationId,
        userId,
        admission,
        abortSignal: abortController?.signal,
      });
      return signal === undefined
        ? abortController
        : abortControllerFromSignal(signal);
    }
    case "no-organization":
      assertModelDispatchScope({ organizationId: null, userId, admission });
      return abortController;
    default:
      admission satisfies never;
      return panic("Unhandled model dispatch admission");
  }
};

export const collectTanStackTextRun = async (
  admitted: AdmittedChatRunOptions,
): Promise<TanStackTextRun> => {
  const options = admittedChatRunOptions(admitted);
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
            : finishedRunOf(chunk);
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
  onFinish,
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
  onFinish?: ((finish: TextRunFinish) => void) | undefined;
}): AsyncIterable<string> {
  const modelAnalytics = analytics?.forModel(model);
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
        ...(modelAnalytics ? { middleware: [modelAnalytics.middleware] } : {}),
        ...(abortController ? { abortController } : {}),
      }),
    onChunk: (chunk) => {
      if (chunk.type === EventType.RUN_FINISHED) {
        onFinish?.(finishedRunOf(chunk));
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
  // Named by this service from the run's own outcome, not by the provider.
  output_incomplete: false,
  output_invalid: false,
  output_moderated: false,
  deadline_exceeded: false,
  loop_detected: false,
  empty_completion: false,
  unknown: false,
} as const satisfies Record<AIErrorKind, boolean>;

// Being tagged is not ownership: better-result's `Panic` and
// `UnhandledException`, and any library's tagged class, carry foreign text.
const OWNED_RUN_FAILURES = [
  HandlerError,
  ChatLoopDetectedError,
  ChatEmptyCompletionError,
] as const;

const isOwnedRunFailure = (error: Error): boolean =>
  OWNED_RUN_FAILURES.some((ErrorClass) => error instanceof ErrorClass);

/**
 * The one exit of a failed model run. Every result carries a message Stella
 * owns: a provider failure becomes a `ProviderCallError`, an application
 * `TaggedError` (a curated refusal, a loop or empty-completion verdict) and
 * the caller's own abort keep their identity, and anything else (a structured
 * output the engine could not parse or validate, a library error thrown
 * mid-run) becomes a `ModelRunError`, whose fixed message holds no model text.
 */
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
    return new ModelRunError({ model });
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
  // An answer that arrived but cannot be used is named from the code the
  // engine or adapter reported, whatever else the chain carries: left to the
  // fallback below it would leave as a bare `ModelRunError` and grade as an
  // unclassified defect.
  if (!isOwnedRunFailure(error) && kind === "output_incomplete") {
    return new ModelOutputIncompleteError({ model });
  }
  if (!isOwnedRunFailure(error) && kind === "output_invalid") {
    return new ModelOutputInvalidError({ model });
  }
  if (
    !hasProviderFailureInCauseChain(evidence) &&
    !PROVIDER_OWNED_ERROR_KIND[kind]
  ) {
    return isOwnedRunFailure(error) ? error : new ModelRunError({ model });
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

type ParseModelOutputOptions<TSchema extends v.GenericSchema> = {
  model: ResolvedTanStackTextModel;
  outputSchema: TSchema;
  output: unknown;
};

// A Valibot issue message can quote the received value, which here is model
// output, so a mismatch surfaces as the fixed-message `ModelOutputInvalidError`.
const parseModelOutput = <TSchema extends v.GenericSchema>({
  model,
  outputSchema,
  output,
}: ParseModelOutputOptions<TSchema>): v.InferOutput<TSchema> => {
  const parsed = v.safeParse(outputSchema, output);
  if (!parsed.success) {
    throw new ModelOutputInvalidError({ model });
  }
  return parsed.output;
};

/**
 * The repair turn a structured answer gets when it does not match its schema.
 *
 * The model is shown its own answer and told exactly where it breaks the
 * schema: the path of each failing value and what the schema expected there.
 * It answers once more, and that answer passes the full schema or the run
 * fails as `output_invalid`. One round only: a repair never repairs a repair,
 * and nothing here fills in, converts or drops a value on the model's behalf.
 *
 * The issue list carries paths and expectations only, never the received
 * value: the outcome line is logged, and a received value is model output
 * that can quote the document.
 */

/** More issues than this add length, not information, to the repair turn. */
const MAX_REPAIR_ISSUES = 20;

type StructuredOutputIssue = {
  /** Dotted path to the failing value; `(root)` for the answer itself. */
  readonly path: string;
  /** What the schema expected there, as Valibot names it. */
  readonly expected: string;
  /** The Valibot issue type (`string`, `strict_object`, `min_length`, ...). */
  readonly type: string;
};

const issuePath = (issue: v.BaseIssue<unknown>): string =>
  issue.path === undefined || issue.path.length === 0
    ? "(root)"
    : issue.path.map(({ key }) => String(key)).join(".");

const structuredOutputIssues = (
  issues: readonly v.BaseIssue<unknown>[],
): StructuredOutputIssue[] =>
  issues.slice(0, MAX_REPAIR_ISSUES).map((issue) => ({
    path: issuePath(issue),
    expected: issue.expected ?? issue.type,
    type: issue.type,
  }));

const repairInstruction = (issues: readonly StructuredOutputIssue[]): string =>
  [
    "Your previous answer does not match the required JSON schema.",
    "Fix exactly these problems and return the complete answer again as one JSON value that matches the schema.",
    "Keep every other value as it was. Do not invent facts to satisfy the schema.",
    "",
    ...issues.map(
      ({ path, expected, type }) => `- ${path}: expected ${expected} (${type})`,
    ),
  ].join("\n");

/**
 * The original conversation plus the invalid answer and the repair request,
 * for the same model. The caller re-guards the list before it is sent: the
 * answer is model output and may carry anything the model saw.
 */
const structuredOutputRepairMessages = <TMessage>({
  messages,
  invalidOutput,
  issues,
}: {
  messages: readonly TMessage[];
  invalidOutput: unknown;
  issues: readonly StructuredOutputIssue[];
}): (TMessage | ModelMessage)[] => [
  ...messages,
  { role: "assistant", content: JSON.stringify(invalidOutput) },
  { role: "user", content: repairInstruction(issues) },
];

const STRUCTURED_OUTPUT_RUNG = {
  NATIVE: "native",
  MODEL_REPAIR: "model_repair",
  FALLBACK_MODEL: "fallback_model",
  FALLBACK_SKIPPED: "fallback_skipped",
} as const;

type StructuredOutputRung =
  (typeof STRUCTURED_OUTPUT_RUNG)[keyof typeof STRUCTURED_OUTPUT_RUNG];

type StructuredOutputOutcome =
  | {
      type: "ok";
      rung: Exclude<
        StructuredOutputRung,
        "fallback_model" | "fallback_skipped"
      >;
    }
  | {
      type: "failed";
      rung: "output_invalid" | "repair_failed" | "fallback_skipped";
    }
  | { type: "ok" | "failed"; rung: "fallback_model"; fallbackModelId: string };

/**
 * One line per structured run that needed or tried a repair, so the repair
 * rate per model and per role is countable. A first-pass success is not
 * logged: it is the common case and the generation events already count it.
 */
const reportStructuredOutputOutcome = ({
  outcome,
  issues,
  modelId,
  provider,
  role,
}: {
  outcome: StructuredOutputOutcome;
  issues: readonly StructuredOutputIssue[];
  modelId: string;
  provider: string;
  role: string;
}): void => {
  if (outcome.type === "ok" && outcome.rung === STRUCTURED_OUTPUT_RUNG.NATIVE) {
    return;
  }
  logger.info("ai.structured_output.outcome", {
    "ai.structured_output.result": outcome.type,
    "ai.structured_output.rung": outcome.rung,
    ...(outcome.rung === STRUCTURED_OUTPUT_RUNG.FALLBACK_MODEL
      ? { "ai.structured_output.fallback_model_id": outcome.fallbackModelId }
      : {}),
    "ai.structured_output.issue_count": issues.length,
    "ai.structured_output.issue_types": [
      ...new Set(issues.map(({ type }) => type)),
    ].join(","),
    "ai.model": modelId,
    "ai.provider": provider,
    "ai.role": role,
  });
};

type OwnerValidatedSchema = StandardJSONSchemaV1<unknown, unknown> &
  StandardSchemaV1<unknown, unknown>;

/**
 * The engine validates a structured answer itself and, on a mismatch, keeps
 * only the error: the answer is gone. It is handed a validator that always
 * passes instead, so this owner validates the answer once against the
 * caller's schema (`settleStructuredOutput`) and can show the model what to
 * fix. The JSON Schema the provider is constrained with is unchanged.
 */
const ownerValidatedSchema = (
  schema: OwnerValidatedSchema,
): OwnerValidatedSchema => ({
  "~standard": {
    ...schema["~standard"],
    validate: (value) => ({ value }),
  },
});

type StructuredOutputRepairTurn = {
  invalidOutput: unknown;
  issues: readonly StructuredOutputIssue[];
};

/**
 * Validates a structured answer and, when it does not match, asks the same
 * model once to fix exactly the reported issues (`structuredOutputRepairMessages`).
 * After a failed repair, a role caller can select one approved model for a
 * fresh request. Every answer passes the full schema or fails; nothing is
 * converted, filled in or dropped. All rungs share the deadline and signal.
 */
const settleStructuredOutput = async <TSchema extends v.GenericSchema>({
  model,
  outputSchema,
  output,
  repair,
  fallback,
  role,
}: ParseModelOutputOptions<TSchema> & {
  repair: (turn: StructuredOutputRepairTurn) => Promise<unknown>;
  fallback?:
    | (() => {
        modelId: string;
        run: () => Promise<{
          model: ResolvedTanStackTextModel;
          output: unknown;
        }>;
      } | null)
    | undefined;
  role: string;
}): Promise<v.InferOutput<TSchema>> => {
  const first = v.safeParse(outputSchema, output);
  if (first.success) {
    return first.output;
  }
  const issues = structuredOutputIssues(first.issues);
  const report = (outcome: StructuredOutputOutcome) =>
    reportStructuredOutputOutcome({
      outcome,
      issues,
      modelId: model.modelId,
      provider: model.provider,
      role,
    });
  // A repair call that is cancelled, times out or fails at the provider still
  // counts as a tried repair; its own error is what the caller sees.
  const repaired = await Result.tryPromise({
    try: async () => await repair({ invalidOutput: output, issues }),
    catch: (error: unknown) => error,
  });
  if (
    Result.isError(repaired) &&
    !(repaired.error instanceof ModelOutputInvalidError)
  ) {
    report({ type: "failed", rung: "repair_failed" });
    throw repaired.error;
  }
  if (Result.isOk(repaired)) {
    const second = v.safeParse(outputSchema, repaired.value);
    if (second.success) {
      report({ type: "ok", rung: STRUCTURED_OUTPUT_RUNG.MODEL_REPAIR });
      return second.output;
    }
  }
  // Callers that own their adapter (chat-object) have no organization/role
  // resolution context. Only the role entry can choose an approved fallback.
  if (fallback === undefined) {
    report({ type: "failed", rung: "output_invalid" });
    throw new ModelOutputInvalidError({ model });
  }
  const candidate = fallback();
  if (candidate === null) {
    report({ type: "failed", rung: STRUCTURED_OUTPUT_RUNG.FALLBACK_SKIPPED });
    throw new ModelOutputInvalidError({ model });
  }
  const attempted = await Result.tryPromise({
    try: candidate.run,
    catch: (error: unknown) => error,
  });
  if (Result.isError(attempted)) {
    report({
      type: "failed",
      rung: STRUCTURED_OUTPUT_RUNG.FALLBACK_MODEL,
      fallbackModelId: candidate.modelId,
    });
    throw attempted.error;
  }
  const final = v.safeParse(outputSchema, attempted.value.output);
  report({
    type: final.success ? "ok" : "failed",
    rung: STRUCTURED_OUTPUT_RUNG.FALLBACK_MODEL,
    fallbackModelId: candidate.modelId,
  });
  if (!final.success) {
    throw new ModelOutputInvalidError({ model: attempted.value.model });
  }
  return final.output;
};

/**
 * The output allowance a structured answer that needs `budget` tokens asks
 * the resolved model for: the budget, bounded by the model's own allowance
 * (`chatTurnOutputTokens`). `undefined` for a model the catalog does not list,
 * which leaves the allowance to the provider rather than guess one.
 */
export const outputTokensWithinModelLimit = (
  model: ResolvedTanStackTextModel,
  budget: number,
): number | undefined => {
  if (!Number.isInteger(budget) || budget <= 0) {
    return panic("An output token budget must be a positive integer");
  }
  const allowance = chatTurnOutputTokens(model);
  return allowance === undefined ? undefined : Math.min(budget, allowance);
};

const requestedOutputTokens = (
  options: {
    maxOutputTokens?: number | undefined;
    outputTokenBudget?: number | undefined;
  },
  model: ResolvedTanStackTextModel,
): number | undefined =>
  options.outputTokenBudget === undefined
    ? options.maxOutputTokens
    : outputTokensWithinModelLimit(model, options.outputTokenBudget);

export const generateTanStackObjectForTask = async <
  TSchema extends v.GenericSchema,
>(
  options: GenerateTanStackObjectForTaskOptions<TSchema> &
    GenerationDeadlineOption,
): Promise<v.InferOutput<TSchema>> =>
  await withGenerationDeadline(
    options,
    async (abortSignal, deadlineAt) =>
      await generateTanStackObjectWithin(
        { ...options, abortSignal },
        deadlineAt,
      ),
  );

const generateTanStackObjectWithin = async <TSchema extends v.GenericSchema>(
  {
    outputMode: _outputMode,
    outputSchema,
    ...options
  }: GenerateTanStackObjectForTaskOptions<TSchema>,
  deadlineAt: number | undefined,
): Promise<v.InferOutput<TSchema>> => {
  // Checked before the model resolves: a dispatch on a settled proof panics.
  const abortSignal = admittedDispatchSignal(options);
  const model = await (options.resolveTextModel ?? resolveTanStackTextModel)(
    options,
  );
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = abortSignal
    ? abortControllerFromSignal(abortSignal)
    : undefined;
  const run = async (
    messages: GuardedModelMessages<ModelMessage[]>,
    requestModel: ResolvedTanStackTextModel,
  ): Promise<unknown> => {
    const analytics = options.analytics?.forModel(requestModel);
    guardStructuredOutputBudget({ model: requestModel, outputSchema });
    const tanStackOutputSchema = ownerValidatedSchema(
      toTanStackValibotSchema(
        outputSchema,
        structuredOutputProjectionOptions({
          mock: isMockTextAdapter(requestModel.adapter),
          provider: requestModel.provider,
        }),
      ),
    );
    const maxOutputTokens = requestedOutputTokens(options, requestModel);
    const generated = await Result.tryPromise({
      try: async () =>
        await withProviderRetryWait(
          abortSignal,
          async () =>
            await withStandardServiceTierFallback({
              abortSignal: abortController?.signal,
              model: requestModel,
              serviceTier: options.serviceTier,
              run: async (serviceTier) =>
                await generateChatObject({
                  adapter: requestModel.adapter,
                  messages,
                  outputSchema: tanStackOutputSchema,
                  tools: options.tools,
                  agentLoopStrategy: options.agentLoopStrategy,
                  ...systemPromptsPatch({
                    caching: options.caching,
                    model: requestModel,
                    system: guardedSystemPrompt(options),
                  }),
                  modelOptions: mergeGenerationOptions({
                    caching: options.caching,
                    model: requestModel,
                    maxOutputTokens,
                    serviceTier,
                    temperature: options.temperature,
                  }),
                  ...(analytics ? { middleware: [analytics.middleware] } : {}),
                  ...(abortController ? { abortController } : {}),
                }),
            }),
          deadlineAt,
        ),
      catch: (error: unknown) => error,
    });
    if (Result.isError(generated)) {
      // A cancelled run ends without a structured result, and the SDK reports
      // that as a plain error rather than an abort. The caller's signal is
      // what tells the two apart, as for text generation.
      if (abortSignal?.aborted === true) {
        throw cancelledGenerationError();
      }
      throw generated.error;
    }
    return generated.value;
  };

  return await settleStructuredOutput({
    model,
    outputSchema,
    output: await run(requestMessages, model),
    // The repair turn carries model output, so the whole list is guarded
    // again rather than appended to the already guarded one.
    repair: async (turn) =>
      await run(
        guardModelMessages({
          messages: structuredOutputRepairMessages({
            ...turn,
            messages: messagesFromInput(options),
          }),
          workspaceIds: options.tenantWorkspaceIds,
        }),
        model,
      ),
    fallback: () => {
      const modelId = getStructuredOutputFallbackModelId({
        ...options,
        failedModelId: model.modelId,
        modelTier: options.admission.modelTier,
      });
      if (modelId === null) {
        return null;
      }
      return {
        modelId,
        run: async () => {
          // Reuse the same admission and policy, with a fresh request carrying
          // only the original guarded conversation to the other model.
          admittedDispatchSignal(options);
          const fallbackModel = await (
            options.resolveTextModel ?? resolveTanStackTextModel
          )({
            ...options,
            modelId,
          });
          // Custom resolvers may pin an adapter instead of honoring overrides.
          // Prove the selected identity before sending the conversation again.
          if (
            `${fallbackModel.provider}::${fallbackModel.modelId}` !== modelId
          ) {
            throw new ModelOutputInvalidError({ model: fallbackModel });
          }
          return {
            model: fallbackModel,
            output: await run(requestMessages, fallbackModel),
          };
        },
      };
    },
    role: options.task,
  });
};

export const streamTanStackObjectForTask = async function* <
  TSchema extends v.GenericSchema,
>({
  outputMode: _outputMode,
  outputSchema,
  ...options
}: GenerateTanStackObjectForTaskOptions<TSchema>): AsyncIterable<
  TanStackStructuredOutputEvent<v.InferOutput<TSchema>>
> {
  // Checked before the model resolves: a dispatch on a settled proof panics.
  const abortSignal = admittedDispatchSignal(options);
  const model = await (options.resolveTextModel ?? resolveTanStackTextModel)(
    options,
  );
  const requestMessages = guardedMessagesFromInput(options);
  const abortController = abortSignal
    ? abortControllerFromSignal(abortSignal)
    : undefined;

  yield* streamTanStackStructuredOutput({
    abortController,
    analytics: options.analytics,
    caching: options.caching,
    maxOutputTokens: requestedOutputTokens(options, model),
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
  // No repair turn here: the caller has already been shown the partial
  // answer, so a mismatch ends the stream as `ModelOutputInvalidError`.
  const tanStackOutputSchema = ownerValidatedSchema(
    toTanStackValibotSchema(
      outputSchema,
      structuredOutputProjectionOptions({
        mock: isMockTextAdapter(model.adapter),
        provider: model.provider,
      }),
    ),
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
      object: parseModelOutput({
        model,
        outputSchema,
        output: chunk.value.object,
      }),
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
  credentials: ReturnType<
    typeof getManagedOpenRouterCredentialProvider
  > = getManagedOpenRouterCredentialProvider(),
): Promise<ResolvedTanStackTextModel> => {
  // Every inference path resolves its model here with the proof that its
  // action was admitted; the type requires the proof, this binds it to the
  // organization the model serves.
  assertModelDispatchScope(options);
  const {
    admission: { modelTier },
    modelId,
    organizationId,
    orgAIConfig,
    reasoningEffort,
    task,
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
      ? getTanStackTextModelInfoById(modelId, orgAIConfig, task, {
          dataClass: policy.dataClass,
          modelTier,
        })
      : getTanStackTextModelInfoForTask(task, orgAIConfig, {
          organizationId,
          modelTier,
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
        task,
        organizationId,
        modelTier,
        reasoningEffort,
        managedOpenRouterCredential,
        ...policy,
      })
    : getTanStackTextModelForTask(task, orgAIConfig, {
        organizationId,
        modelTier,
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
  options: TanStackTextForTaskOptions,
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
  hashSha256Hex(raw).slice(0, PROVIDER_CACHE_KEY_MAX);

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
 * Reasoning tokens a request reserves on top of the reply's allowance, per
 * reasoning effort. Gemini (`maxOutputTokens`), OpenAI (`max_output_tokens`)
 * and OpenRouter (`max_completion_tokens`) count a thinking model's reasoning
 * inside the one output ceiling and take a level rather than a token budget,
 * so a short reply's allowance (a title, a handful of search terms) is
 * otherwise spent on reasoning before the reply starts, and the run stops at
 * the ceiling with no answer. A reservation is a ceiling, not a spend: usage
 * bills what the model used.
 */
const REASONING_RESERVATION_BY_EFFORT = {
  none: 0,
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16_384,
  xhigh: 32_768,
  max: 32_768,
} as const satisfies Record<ReasoningEffort, number>;

const REASONING_EFFORT_BY_GOOGLE_LEVEL = {
  MINIMAL: "minimal",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const satisfies Record<string, ReasoningEffort>;

type ReasoningCeilingModel = Extract<
  ResolvedTanStackTextModel,
  { provider: "google" | "openai" | "openrouter" }
>;

/**
 * The effort a request runs at: the one it sends, else the model's published
 * default (a reasoning model left without a level still reasons).
 */
const requestReasoningEffort = (
  model: ReasoningCeilingModel,
): ReasoningEffort => {
  const fallback = getModelDefaultReasoningEffort(model.modelId) ?? "none";
  if (model.provider !== "google") {
    return model.modelOptions.reasoning?.effort ?? fallback;
  }
  const level: keyof typeof REASONING_EFFORT_BY_GOOGLE_LEVEL | undefined =
    model.modelOptions.thinkingConfig?.thinkingLevel;
  return level === undefined
    ? fallback
    : REASONING_EFFORT_BY_GOOGLE_LEVEL[level];
};

/**
 * The output ceiling a request sends for a reply sized `maxOutputTokens`: the
 * allowance plus the reasoning reservation, bounded by the model's catalog
 * output limit and never below the allowance itself.
 */
const reasoningCeiling = (
  model: ReasoningCeilingModel,
  maxOutputTokens: number,
): number => {
  const reserved =
    maxOutputTokens +
    REASONING_RESERVATION_BY_EFFORT[requestReasoningEffort(model)];
  const limit = getOutputTokenLimit(model.modelId);
  return limit === undefined
    ? reserved
    : Math.max(maxOutputTokens, Math.min(reserved, limit));
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
  // Caller temperature overrides only apply where the task builder
  // itself emitted a temperature. Builder omission is always
  // deliberate — the model rejects, deprecates, or ignores sampling
  // overrides (`MODEL_TEMPERATURE_POLICIES`), the id is uncatalogued, or the
  // task runs a thinking/reasoning mode that is incompatible with
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
        ...(maxOutputTokens === undefined
          ? {}
          : {
              [OUTPUT_CEILING_OPTION.google]: reasoningCeiling(
                model,
                maxOutputTokens,
              ),
            }),
        ...temperatureOverride,
        ...googleServiceTierOptions(serviceTier),
      };
    case "anthropic": {
      const anthropicOptions = {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : {
              [OUTPUT_CEILING_OPTION.anthropic]:
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
          : { [OUTPUT_CEILING_OPTION.bedrock]: maxOutputTokens }),
        ...temperatureOverride,
      };
    case "mistral":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : { [OUTPUT_CEILING_OPTION.mistral]: maxOutputTokens }),
        ...temperatureOverride,
      };
    case "openai":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : {
              [OUTPUT_CEILING_OPTION.openai]: reasoningCeiling(
                model,
                maxOutputTokens,
              ),
            }),
        ...temperatureOverride,
        ...openAICacheOptions(caching),
        ...openAIServiceTierOptions(serviceTier),
      };
    case "openrouter":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : {
              [OUTPUT_CEILING_OPTION.openrouter]: reasoningCeiling(
                model,
                maxOutputTokens,
              ),
            }),
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

/**
 * A `RUN_ERROR` as a wrapped run hands it out: the fixed provider-call message
 * and the classified kind as its code, plus the usage the provider billed
 * before the run failed. The provider's own message, code and raw event stay
 * behind, so a consumer that persists or forwards the chunk carries only these.
 */
type TanStackRunErrorChunk = Pick<RunErrorEvent, "type" | "timestamp"> & {
  message: typeof PROVIDER_CALL_ERROR_MESSAGE;
  code: AIErrorKind;
  usage?: TokenUsage;
};

type TanStackChatRunChunk =
  | Exclude<
      PublicStreamChunk,
      { type: EventType.RUN_ERROR } | { type: "RUN_ERROR" }
    >
  | TanStackRunErrorChunk;

const tanStackRunErrorChunk = (
  chunk: RunErrorEvent,
  model: ResolvedTanStackTextModel,
): TanStackRunErrorChunk => {
  const usage = tokenUsageFromTerminalChunk(chunk);
  return {
    type: EventType.RUN_ERROR,
    ...(chunk.timestamp === undefined ? {} : { timestamp: chunk.timestamp }),
    message: PROVIDER_CALL_ERROR_MESSAGE,
    code: tanStackRunError(chunk, model).kind,
    ...(usage === undefined ? {} : { usage }),
  };
};

/**
 * Stream a chat run whose chunks a caller consumes itself (a subagent's tool
 * loop). A `RUN_ERROR` arrives projected to {@link TanStackRunErrorChunk}, and
 * a thrown failure leaves through `withRecoveredProviderStatus`, so neither
 * carries provider text.
 *
 * @yields The run's chunks, with each `RUN_ERROR` projected.
 */
export const streamTanStackChatRun = async function* (
  admitted: AdmittedChatRunOptions,
): AsyncIterable<TanStackChatRunChunk> {
  const { model, ...options } = admittedChatRunOptions(admitted);
  try {
    for await (const chunk of streamChatChunks(options)) {
      yield chunk.type === EventType.RUN_ERROR
        ? tanStackRunErrorChunk(chunk, model)
        : chunk;
    }
  } catch (error) {
    throw withRecoveredProviderStatus({
      error,
      model,
      abortSignal: options.abortController?.signal,
    });
  }
};

type ChatObjectMessages = NonNullable<StreamChatChunksOptions["messages"]>;

type GenerateTanStackChatObjectOptions<TSchema extends v.GenericSchema> =
  AdmittedChatRunOptions & {
    outputSchema: TSchema;
    /** Tenant set the repair turn is guarded with; it carries model output. */
    tenantWorkspaceIds: readonly SafeId<"workspace">[];
  };

/**
 * The awaited structured-output run for a caller that assembles its own chat
 * options (tools, an agent loop). Failures leave through
 * `withRecoveredProviderStatus` and the output is parsed against `outputSchema`.
 */
export const generateTanStackChatObject = async <
  TSchema extends v.GenericSchema,
>({
  outputSchema,
  tenantWorkspaceIds,
  ...admitted
}: GenerateTanStackChatObjectOptions<TSchema>): Promise<
  v.InferOutput<TSchema>
> => {
  const { model, ...options } = admittedChatRunOptions(admitted);
  const requestMessages: ChatObjectMessages =
    options.messages ?? panic("A structured chat run needs its messages");
  const run = async (messages: ChatObjectMessages): Promise<unknown> => {
    const result = await Result.tryPromise({
      try: async () =>
        await generateChatObject({
          ...options,
          messages,
          outputSchema: ownerValidatedSchema(
            toTanStackValibotSchema(outputSchema),
          ),
        }),
      catch: (error) => error,
    });
    if (Result.isError(result)) {
      throw withRecoveredProviderStatus({
        error: result.error,
        model,
        abortSignal: options.abortController?.signal,
      });
    }
    return result.value;
  };
  return await settleStructuredOutput({
    model,
    outputSchema,
    output: await run(requestMessages),
    repair: async (turn) =>
      await run(
        guardModelMessages({
          messages: structuredOutputRepairMessages({
            ...turn,
            messages: requestMessages,
          }),
          workspaceIds: tenantWorkspaceIds,
        }),
      ),
    role: "chat-object",
  });
};
