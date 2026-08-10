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
} from "@stll/ai-catalog";
import type {
  BYOKProvider,
  ModelRole,
  ReasoningEffort,
} from "@stll/ai-catalog";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getActiveProvider,
  getTanStackTextModelInfoForRole,
  hasTanStackInstanceProvider,
  isAllowedBYOKModelForRole,
} from "@/api/lib/tanstack-ai-models";

const CHAT_MODEL_ROLE: ModelRole = "chat";

export type ChatModelSelection = {
  provider: BYOKProvider;
  modelId: string;
};

export type ChatModelOption = ChatModelSelection & {
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
}: ChatModelSelection): string => `${provider}::${modelId}`;

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
): ChatModelSelection | null => {
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
}: ChatModelSelection & { orgAIConfig: OrgAIConfig | null }): boolean => {
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

const chatModelOptionsForProvider = (
  provider: BYOKProvider,
): ChatModelOption[] =>
  BYOK_MODEL_OPTIONS[provider].map((modelId) => {
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
  });

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
}: ChatModelSelection): readonly ReasoningEffort[] | null =>
  CHAT_REASONING_EFFORT_EXPOSURE[provider] === "exposed"
    ? getModelReasoningEfforts(modelId)
    : null;

export const isChatModelReasoningEffortAvailable = ({
  provider,
  modelId,
  reasoningEffort,
}: ChatModelSelection & { reasoningEffort: ReasoningEffort }): boolean =>
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
): ChatModelOption[] =>
  configuredChatProviders(orgAIConfig).flatMap(chatModelOptionsForProvider);

/**
 * The encoded selection a send would use absent a thread override, or
 * `null` when the chat role has no usable configured provider or model.
 * Unexpected resolver failures propagate to the handler boundary.
 */
export const getDefaultChatModelValue = ({
  orgAIConfig,
  organizationId,
}: {
  orgAIConfig: OrgAIConfig | null;
  organizationId: SafeId<"organization"> | null;
}): string | null => {
  if (!hasResolvableModelForRole({ orgAIConfig, role: CHAT_MODEL_ROLE })) {
    return null;
  }

  const info = getTanStackTextModelInfoForRole(CHAT_MODEL_ROLE, orgAIConfig, {
    organizationId,
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
