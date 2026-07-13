import { EventType, chat, parsePartialJSON } from "@tanstack/ai";
import type {
  ModelMessage,
  StructuredOutputPart,
  SystemPrompt,
} from "@tanstack/ai";
import type { OpenAITextProviderOptions } from "@tanstack/ai-openai";
import type { OpenRouterResponsesTextProviderOptions } from "@tanstack/ai-openrouter";
import * as v from "valibot";

import type { ModelRole } from "@stll/ai-catalog";

import type {
  AIRequestServiceTier,
  CachingDecision,
  OrgAIConfig,
} from "@/api/lib/ai-config";
import type { TanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { nullUnionStrategyForTanStackProvider } from "@/api/lib/provider-safe-json-schema";
import { tanStackCacheControl } from "@/api/lib/tanstack-ai-caching";
import {
  getTanStackTextModelById,
  getTanStackTextModelForRole,
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

type GenerateTanStackBaseOptions = {
  abortSignal?: AbortSignal | undefined;
  analytics?: TanStackAIAnalyticsCallbacks | undefined;
  caching: CachingDecision;
  maxOutputTokens?: number | undefined;
  modelId?: string | undefined;
  organizationId: SafeId<"organization"> | null;
  orgAIConfig: OrgAIConfig | null | undefined;
  role: ModelRole;
  serviceTier: AIRequestServiceTier;
  system?: string | undefined;
  temperature?: number | undefined;
};

type GenerateTanStackTextForRoleOptions = GenerateTanStackBaseOptions &
  GenerateTanStackInputOptions;

type GenerateTanStackObjectForRoleOptions<TSchema extends v.GenericSchema> =
  GenerateTanStackTextForRoleOptions & {
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
  "modelId" | "organizationId" | "orgAIConfig" | "role"
>;

export const generateTanStackTextForRole = async (
  options: GenerateTanStackTextForRoleOptions,
): Promise<string> => {
  const model = resolveTanStackTextModel(options);
  const requestMessages = messagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;

  return await withStandardServiceTierFallback({
    model,
    serviceTier: options.serviceTier,
    run: async (serviceTier) =>
      await chat({
        adapter: model.adapter,
        messages: requestMessages,
        stream: false,
        ...systemPromptsPatch({
          caching: options.caching,
          model,
          system: options.system,
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
};

export const streamTanStackTextForRole = (
  options: GenerateTanStackTextForRoleOptions,
): AsyncIterable<string> => {
  const model = resolveTanStackTextModel(options);
  const requestMessages = messagesFromInput(options);
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
    system: options.system,
    temperature: options.temperature,
  });
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
}: {
  abortController: AbortController | undefined;
  analytics: TanStackAIAnalyticsCallbacks | undefined;
  caching: CachingDecision;
  maxOutputTokens: number | undefined;
  messages: ModelMessage[];
  model: ResolvedTanStackTextModel;
  serviceTier: AIRequestServiceTier;
  system: string | undefined;
  temperature: number | undefined;
}): AsyncIterable<string> {
  yield* iterateWithStandardServiceTierFallback({
    model,
    serviceTier,
    stream: (requestedServiceTier) =>
      chat({
        adapter: model.adapter,
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

type StandardServiceTierStreamFallbackOptions<TChunk, TResult> = {
  model: ResolvedTanStackTextModel;
  serviceTier: AIRequestServiceTier;
  stream: (serviceTier: AIRequestServiceTier) => AsyncIterable<TChunk>;
  onChunk: (chunk: TChunk) => TResult | undefined;
};

const iterateWithStandardServiceTierFallback = async function* <
  TChunk,
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
    const result = onChunk(chunk);
    if (result !== undefined) {
      yield result;
    }
  }
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

const isRetryableServiceTierFallbackError = (error: unknown): boolean => {
  if (!isRecord(error)) {
    return false;
  }

  const statusCode = providerStatusCode(error);
  if (statusCode === null) {
    return false;
  }

  const isRetryable = error["isRetryable"];
  if (isRetryable === false) {
    return false;
  }
  if (isRetryable === true) {
    return true;
  }

  return statusCode === 429 || statusCode >= 500;
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

export const generateTanStackObjectForRole = async <
  TSchema extends v.GenericSchema,
>({
  outputSchema,
  ...options
}: GenerateTanStackObjectForRoleOptions<TSchema>): Promise<
  v.InferOutput<TSchema>
> => {
  const model = resolveTanStackTextModel(options);
  const requestMessages = messagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;
  const tanStackOutputSchema = toTanStackValibotSchema(outputSchema, {
    nullUnionStrategy: nullUnionStrategyForTanStackProvider(model.provider),
  });

  const output = await withStandardServiceTierFallback({
    model,
    serviceTier: options.serviceTier,
    run: async (serviceTier) =>
      await chat({
        adapter: model.adapter,
        messages: requestMessages,
        outputSchema: tanStackOutputSchema,
        ...systemPromptsPatch({
          caching: options.caching,
          model,
          system: options.system,
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
  const model = resolveTanStackTextModel(options);
  const requestMessages = messagesFromInput(options);
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
    system: options.system,
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
  messages: ModelMessage[];
  model: ResolvedTanStackTextModel;
  outputSchema: TSchema;
  serviceTier: AIRequestServiceTier;
  system: string | undefined;
  temperature: number | undefined;
}): AsyncIterable<TanStackStructuredOutputEvent<v.InferOutput<TSchema>>> {
  let completed = false;
  let rawJson = "";
  const tanStackOutputSchema = toTanStackValibotSchema(outputSchema, {
    nullUnionStrategy: nullUnionStrategyForTanStackProvider(model.provider),
  });

  const stream = iterateWithStandardServiceTierFallback({
    model,
    serviceTier,
    stream: (requestedServiceTier) =>
      chat({
        adapter: model.adapter,
        messages,
        outputSchema: tanStackOutputSchema,
        stream: true,
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
  role,
}: ResolveTextModelOptions): ResolvedTanStackTextModel =>
  modelId
    ? getTanStackTextModelById(modelId, orgAIConfig, {
        role,
        organizationId,
      })
    : getTanStackTextModelForRole(role, orgAIConfig, { organizationId });

const messagesFromInput = (
  input: GenerateTanStackInputOptions,
): ModelMessage[] => {
  if ("messages" in input) {
    return input.messages;
  }
  return [{ role: "user", content: input.prompt }];
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
  switch (model.provider) {
    case "google":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(temperature === undefined ? {} : { temperature }),
        ...googleServiceTierOptions(serviceTier),
      };
    case "anthropic": {
      const anthropicOptions = {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : { max_tokens: maxOutputTokens }),
      };
      if (temperature === undefined || !("temperature" in model.modelOptions)) {
        return anthropicOptions;
      }
      return { ...anthropicOptions, temperature };
    }
    case "bedrock":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : { max_completion_tokens: maxOutputTokens }),
        ...(temperature === undefined ? {} : { temperature }),
      };
    case "mistral":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : { max_tokens: maxOutputTokens }),
        ...(temperature === undefined ? {} : { temperature }),
      };
    case "openai":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: maxOutputTokens }),
        ...(temperature === undefined ? {} : { temperature }),
        ...openAICacheOptions(caching),
        ...openAIServiceTierOptions(serviceTier),
      };
    case "openrouter":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(temperature === undefined ? {} : { temperature }),
        ...openRouterCacheOptions(caching),
        ...openRouterServiceTierOptions(serviceTier),
      };
    default: {
      const _exhaustive: never = model;
      return _exhaustive;
    }
  }
};

const isDeferredServiceTier = (serviceTier: AIRequestServiceTier): boolean =>
  serviceTier === "flex" || serviceTier === "batch";

// `prompt_cache_retention` is omitted because no single value is valid across
// this catalogue: the API accepts "in_memory" | "24h", but gpt-5.5 supports only
// "24h". Omission is the one portable choice, and it takes the provider default:
// "24h" for a non-ZDR org, "in_memory" for a ZDR one. Retention is a per-model
// capability, so setting it belongs in the model catalogue, not here.
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

const openRouterCacheOptions = (
  caching: CachingDecision,
): Partial<Pick<OpenRouterResponsesTextProviderOptions, "promptCacheKey">> => {
  if (!caching.enabled || caching.scopeKey === null) {
    return {};
  }
  return { promptCacheKey: hashCacheScopeKey(caching.scopeKey) };
};

const openAIServiceTierOptions = (
  serviceTier: AIRequestServiceTier,
): Pick<OpenAITextProviderOptions, "service_tier"> => ({
  service_tier: isDeferredServiceTier(serviceTier) ? "flex" : "default",
});

const openRouterServiceTierOptions = (
  serviceTier: AIRequestServiceTier,
): Pick<OpenRouterResponsesTextProviderOptions, "serviceTier"> => ({
  serviceTier: isDeferredServiceTier(serviceTier) ? "flex" : "default",
});

const googleServiceTierOptions = (
  serviceTier: AIRequestServiceTier,
): Pick<TanStackModelOptions<"google">, "serviceTier"> => ({
  serviceTier: isDeferredServiceTier(serviceTier) ? "flex" : "standard",
});
