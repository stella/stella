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
  serviceTier?: AIRequestServiceTier | undefined;
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

  return await chat({
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
      serviceTier: options.serviceTier,
      temperature: options.temperature,
    }),
    ...(options.analytics
      ? { middleware: [options.analytics.middleware] }
      : {}),
    ...(abortController ? { abortController } : {}),
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
  serviceTier: AIRequestServiceTier | undefined;
  system: string | undefined;
  temperature: number | undefined;
}): AsyncIterable<string> {
  const stream = chat({
    adapter: model.adapter,
    messages,
    ...systemPromptsPatch({ caching, model, system }),
    modelOptions: mergeGenerationOptions({
      caching,
      model,
      maxOutputTokens,
      serviceTier,
      temperature,
    }),
    ...(analytics ? { middleware: [analytics.middleware] } : {}),
    ...(abortController ? { abortController } : {}),
  });

  for await (const chunk of stream) {
    if (
      chunk.type === EventType.TEXT_MESSAGE_CONTENT &&
      chunk.delta.length > 0
    ) {
      yield chunk.delta;
    }
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
  const model = resolveTanStackTextModel(options);
  const requestMessages = messagesFromInput(options);
  const abortController = options.abortSignal
    ? abortControllerFromSignal(options.abortSignal)
    : undefined;
  const tanStackOutputSchema = toTanStackValibotSchema(outputSchema);

  const output = await chat({
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
      serviceTier: options.serviceTier,
      temperature: options.temperature,
    }),
    ...(options.analytics
      ? { middleware: [options.analytics.middleware] }
      : {}),
    ...(abortController ? { abortController } : {}),
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
  serviceTier: AIRequestServiceTier | undefined;
  system: string | undefined;
  temperature: number | undefined;
}): AsyncIterable<TanStackStructuredOutputEvent<v.InferOutput<TSchema>>> {
  let completed = false;
  let rawJson = "";
  const tanStackOutputSchema = toTanStackValibotSchema(outputSchema);
  const stream = chat({
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
      serviceTier,
      temperature,
    }),
    ...(analytics ? { middleware: [analytics.middleware] } : {}),
    ...(abortController ? { abortController } : {}),
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

    if (
      chunk.type !== EventType.CUSTOM ||
      chunk.name !== "structured-output.complete"
    ) {
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

  // SAFETY: TanStack derives StructuredOutputPart<T>.partial the same way:
  // parse the accumulated JSON prefix and expose it as DeepPartial<T> until
  // the final structured-output.complete event validates the complete object.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return parsed as TanStackStructuredOutputPartial<TOutput>;
};

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
  serviceTier: AIRequestServiceTier | undefined;
  temperature: number | undefined;
}): TanStackModelOptions => {
  switch (model.provider) {
    case "google":
      return {
        ...model.modelOptions,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(temperature === undefined ? {} : { temperature }),
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

const openAICacheOptions = (
  caching: CachingDecision,
): Partial<
  Pick<OpenAITextProviderOptions, "prompt_cache_key" | "prompt_cache_retention">
> => {
  if (!caching.enabled || caching.scopeKey === null) {
    return {};
  }
  return {
    prompt_cache_key: hashCacheScopeKey(caching.scopeKey),
    prompt_cache_retention: "in-memory",
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
  serviceTier: AIRequestServiceTier | undefined,
): Partial<Pick<OpenAITextProviderOptions, "service_tier">> => {
  if (serviceTier === undefined) {
    return {};
  }
  return {
    service_tier: isDeferredServiceTier(serviceTier) ? "flex" : "default",
  };
};

const openRouterServiceTierOptions = (
  serviceTier: AIRequestServiceTier | undefined,
): Partial<Pick<OpenRouterResponsesTextProviderOptions, "serviceTier">> => {
  if (serviceTier === undefined) {
    return {};
  }
  return {
    serviceTier: isDeferredServiceTier(serviceTier) ? "flex" : "default",
  };
};
