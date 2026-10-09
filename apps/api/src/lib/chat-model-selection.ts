import { panic } from "better-result";

/**
 * Per-thread chat-role model selection: encode/decode the
 * `"<provider>::<modelId>"` string stored in `chatThreads.chatModel`, and
 * validate a decoded selection against the org's currently configured
 * chat-role catalog.
 *
 * Mirrors `encodeModelSelection`/`decodeModelSelection` in
 * `apps/web/src/components/ai-config-role-models.logic.ts` (the org AI
 * config's model picker), but decodes server-side without importing
 * frontend code — `decodeChatModelSelection` is the API-side source of
 * truth for this encoding.
 *
 * The "chat" role never restricts by input modality (that only applies to
 * "pdf"; see `isBYOKModelRoleSupported` in `@stll/ai-catalog`), so every
 * offered `BYOK_MODEL_OPTIONS` entry for a configured provider is a valid
 * chat-role selection.
 */
import {
  BYOK_MODEL_OPTIONS,
  getModelDefaultReasoningEffort,
  getModelDisplayMetadata,
  getModelReasoningEfforts,
  TANSTACK_AI_PROVIDERS,
} from "@stll/ai-catalog";
import type {
  BYOKProvider,
  ModelRole,
  ReasoningEffort,
} from "@stll/ai-catalog";
import { classifyBenchmarkModelOptions } from "@stll/ai-catalog/benchmark-frontier";
import type {
  ClassifiedBenchmarkModelOption,
  ModelBenchmarkAvailability,
  ModelBenchmarkMeasurement,
} from "@stll/ai-catalog/benchmark-frontier";
import {
  getModelBenchmarkMeasurements,
  getModelUnratedReason,
  getTypicalCallCostUsd,
} from "@stll/ai-catalog/benchmarks";
import type { ModelUnratedReason } from "@stll/ai-catalog/benchmarks";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getActiveProvider,
  getTanStackTextModelInfoForRole,
  hasTanStackInstanceProvider,
  isAllowedBYOKModelForRole,
} from "@/api/lib/tanstack-ai-models";
import type { ManagedModelTier } from "@/api/lib/usage/managed-model-tier";

const CHAT_MODEL_ROLE: ModelRole = "chat";

export type BYOKChatModelSelection = {
  provider: BYOKProvider;
  modelId: string;
};

export type BYOKChatModelOption = BYOKChatModelSelection & {
  defaultReasoningEffort: ReasoningEffort | null;
  displayName: string;
  iconProvider: BYOKProvider;
  reasoningEfforts: readonly ReasoningEffort[] | null;
  value: string;
};

export type EffectiveChatModelSelection = {
  modelId: string | undefined;
  reasoningEffort: ReasoningEffort | undefined;
};

const isBYOKProviderValue = (value: string): value is BYOKProvider =>
  Object.hasOwn(BYOK_MODEL_OPTIONS, value);

export const encodeChatModelSelection = ({
  provider,
  modelId,
}: BYOKChatModelSelection): string => `${provider}::${modelId}`;

/**
 * Strict decode for the persisted thread-level override. Unlike the
 * dev-only `decodeModelOverride` in `tanstack-ai-models.ts` (which treats
 * an unrecognized provider prefix as a bare model id for the local dev
 * sidebar), this column only ever stores the full encoded form written by
 * `GET /chat/model-options` — an unrecognized or malformed value is
 * invalid, never a fallback bare model id.
 */
export const decodeChatModelSelection = (
  value: string,
): BYOKChatModelSelection | null => {
  const [providerRaw, ...modelParts] = value.split("::");
  const modelId = modelParts.join("::");
  if (!providerRaw || !modelId || !isBYOKProviderValue(providerRaw)) {
    return null;
  }
  return { provider: providerRaw, modelId };
};

/**
 * Whether a decoded selection is currently usable for the chat role: the
 * model must still be offered in the catalog, and the provider must be
 * configured for this org (or, absent an org BYOK config, be the
 * deployment's single active instance provider).
 */
export const isChatModelSelectionAvailable = ({
  provider,
  modelId,
  orgAIConfig,
}: BYOKChatModelSelection & { orgAIConfig: OrgAIConfig | null }): boolean => {
  if (
    !isAllowedBYOKModelForRole({ provider, modelId, role: CHAT_MODEL_ROLE })
  ) {
    return false;
  }
  if (orgAIConfig) {
    return orgAIConfig.providers.some(
      (providerConfig) => providerConfig.provider === provider,
    );
  }
  return hasTanStackInstanceProvider() && getActiveProvider() === provider;
};

const chatModelOption = (
  provider: BYOKProvider,
  modelId: string,
): BYOKChatModelOption => {
  const metadata = getModelDisplayMetadata(modelId);
  if (metadata === null) {
    return panic(`Missing display metadata for offered model "${modelId}"`);
  }
  return {
    defaultReasoningEffort:
      provider === "openrouter"
        ? getModelDefaultReasoningEffort(modelId)
        : null,
    provider,
    modelId,
    displayName: metadata.displayName,
    iconProvider: metadata.iconProvider,
    reasoningEfforts: getChatModelReasoningEfforts({ provider, modelId }),
    value: encodeChatModelSelection({ provider, modelId }),
  };
};

const chatModelOptionsForProvider = (
  provider: BYOKProvider,
): BYOKChatModelOption[] =>
  BYOK_MODEL_OPTIONS[provider].map((modelId) =>
    chatModelOption(provider, modelId),
  );

const CHAT_REASONING_EFFORT_EXPOSURE = {
  google: "exposed",
  anthropic: "exposed",
  openai: "exposed",
  openrouter: "exposed",
  bedrock: "hidden",
  mistral: "hidden",
} as const satisfies Record<BYOKProvider, "exposed" | "hidden">;

/** Effort values the active Stella adapter can actually forward. */
export const getChatModelReasoningEfforts = ({
  provider,
  modelId,
}: BYOKChatModelSelection): readonly ReasoningEffort[] | null =>
  CHAT_REASONING_EFFORT_EXPOSURE[provider] === "exposed"
    ? getModelReasoningEfforts(modelId)
    : null;

export const isChatModelReasoningEffortAvailable = ({
  provider,
  modelId,
  reasoningEffort,
}: BYOKChatModelSelection & { reasoningEffort: ReasoningEffort }): boolean =>
  getChatModelReasoningEfforts({ provider, modelId })?.includes(
    reasoningEffort,
  ) ?? false;

const configuredChatProviders = (
  orgAIConfig: OrgAIConfig | null,
): BYOKProvider[] => {
  if (orgAIConfig) {
    const providers: BYOKProvider[] = [];
    for (const providerConfig of orgAIConfig.providers) {
      if (isBYOKProviderValue(providerConfig.provider)) {
        providers.push(providerConfig.provider);
      }
    }
    return providers;
  }
  if (!hasTanStackInstanceProvider()) {
    return [];
  }
  const activeProvider = getActiveProvider();
  return isBYOKProviderValue(activeProvider) ? [activeProvider] : [];
};

const hasResolvableModelForRole = ({
  orgAIConfig,
  role,
}: {
  orgAIConfig: OrgAIConfig | null;
  role: ModelRole;
}): boolean => {
  if (!orgAIConfig) {
    return hasTanStackInstanceProvider();
  }

  const selection = orgAIConfig.overrideModels[role];
  return (
    isBYOKProviderValue(selection.provider) &&
    orgAIConfig.providers.some(
      (providerConfig) => providerConfig.provider === selection.provider,
    ) &&
    isAllowedBYOKModelForRole({
      provider: selection.provider,
      modelId: selection.modelId,
      role,
    })
  );
};

/**
 * Chat-role model options across every provider currently configured for
 * the org (or the single instance provider when no org BYOK config
 * exists). Member-readable: only model identifiers, never key material.
 */
export const getConfiguredChatModelOptions = (
  orgAIConfig: OrgAIConfig | null,
): BYOKChatModelOption[] =>
  configuredChatProviders(orgAIConfig).flatMap(chatModelOptionsForProvider);

type BenchmarkRouteOption = BYOKChatModelOption & {
  availability: ModelBenchmarkAvailability;
  costPerTypicalCallUsd: number | null;
  measurements: ModelBenchmarkMeasurement[];
  /** Why the catalog has no exact Arena row for this model; `null` if it has one. */
  unratedReason: ModelUnratedReason | null;
};

export type ChatModelBenchmarkOption =
  ClassifiedBenchmarkModelOption<BenchmarkRouteOption>;

/**
 * Every offered chat route with its cost and quality trade-off, classified
 * once over the whole catalog so clients receive only the verdicts. Routes
 * whose provider is not configured stay listed with `provider_unconfigured`
 * so the comparison shows what configuring a provider would unlock; the
 * picker re-derives its own frontier over the available routes. Only efforts
 * the route can actually be sent with are kept.
 */
export const getChatModelBenchmarkOptions = (
  orgAIConfig: OrgAIConfig | null,
): ChatModelBenchmarkOption[] => {
  const configuredProviders = new Set(configuredChatProviders(orgAIConfig));
  const routes: BenchmarkRouteOption[] = [];
  for (const provider of TANSTACK_AI_PROVIDERS) {
    const availability = configuredProviders.has(provider)
      ? "available"
      : "provider_unconfigured";
    for (const modelId of BYOK_MODEL_OPTIONS[provider]) {
      const option = chatModelOption(provider, modelId);
      const benchmark = {
        availability,
        costPerTypicalCallUsd: getTypicalCallCostUsd(modelId),
        measurements: getModelBenchmarkMeasurements(modelId).filter(
          ({ reasoningEffort }) =>
            reasoningEffort === null ||
            (option.reasoningEfforts?.includes(reasoningEffort) ?? false),
        ),
        unratedReason: getModelUnratedReason(modelId),
      } satisfies Omit<BenchmarkRouteOption, keyof BYOKChatModelOption>;
      routes.push({ ...option, ...benchmark });
    }
  }
  return classifyBenchmarkModelOptions(routes);
};

/**
 * The encoded selection a send would use absent a thread override, or
 * `null` when the chat role has no usable configured provider or model.
 * Unexpected resolver failures propagate to the handler boundary.
 */
export const getDefaultChatModelValue = ({
  orgAIConfig,
  organizationId,
  modelTier,
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization"> | null;
  modelTier: ManagedModelTier;
}): string | null => {
  if (!hasResolvableModelForRole({ orgAIConfig, role: CHAT_MODEL_ROLE })) {
    return null;
  }

  const info = getTanStackTextModelInfoForRole(CHAT_MODEL_ROLE, orgAIConfig, {
    dataClass: "customer",
    organizationId,
    modelTier,
  });
  return encodeChatModelSelection({
    provider: info.provider,
    modelId: info.modelId,
  });
};

/**
 * Resolves the effective chat model override for a turn: the dev
 * override (local-only, already validated by
 * `validateTanStackDevModelOverride`) always wins; otherwise a valid
 * thread-level override is used; otherwise `undefined` so callers fall
 * through to the org's chat-role default. A stale thread override
 * (provider key removed, model dropped from the catalog) is silently
 * dropped here rather than failing the send.
 */
export const resolveEffectiveChatModelId = ({
  devModelId,
  threadChatModel,
  orgAIConfig,
}: {
  devModelId: string | undefined;
  threadChatModel: string | null;
  orgAIConfig: OrgAIConfig | null;
}): string | undefined => {
  if (devModelId) {
    return devModelId;
  }
  if (!threadChatModel) {
    return undefined;
  }
  const decoded = decodeChatModelSelection(threadChatModel);
  if (!decoded || !isChatModelSelectionAvailable({ ...decoded, orgAIConfig })) {
    return undefined;
  }
  return threadChatModel;
};

/**
 * Resolve the complete per-turn manual selection. A stale effort degrades to
 * Stella's adapter default; a stale model degrades to Auto.
 */
export const resolveEffectiveChatModelSelection = ({
  devModelId,
  threadChatModel,
  threadReasoningEffort,
  orgAIConfig,
}: {
  devModelId: string | undefined;
  threadChatModel: string | null;
  threadReasoningEffort: ReasoningEffort | null;
  orgAIConfig: OrgAIConfig | null;
}): EffectiveChatModelSelection => {
  const modelId = resolveEffectiveChatModelId({
    devModelId,
    threadChatModel,
    orgAIConfig,
  });
  if (devModelId || modelId === undefined || threadReasoningEffort === null) {
    return { modelId, reasoningEffort: undefined };
  }
  const decoded = decodeChatModelSelection(modelId);
  const reasoningEffort =
    decoded &&
    isChatModelReasoningEffortAvailable({
      ...decoded,
      reasoningEffort: threadReasoningEffort,
    })
      ? threadReasoningEffort
      : undefined;
  return { modelId, reasoningEffort };
};
