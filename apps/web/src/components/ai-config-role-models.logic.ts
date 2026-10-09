import { panic } from "better-result";

import {
  BYOK_DEFAULT_MODELS,
  BYOK_MODEL_OPTIONS,
  isBYOKModelRoleSupported,
  isBYOKProviderRoleSupported,
  DECISION_MODEL_PROVIDERS,
  DECISION_MODEL_CATALOG,
} from "@stll/ai-catalog";

import type { TranslationKey } from "@/i18n/types";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";

export const PROVIDER_KEYS = [
  "google",
  "anthropic",
  "openai",
  "openrouter",
  "mistral",
  "bedrock",
] as const;

export const PROVIDER_LABELS = {
  google: "Google",
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  bedrock: "Bedrock",
} as const satisfies Record<(typeof PROVIDER_KEYS)[number], string>;

export const ROLE_KEYS = ["chat", "fast", "reasoning", "pdf"] as const;

export type ProviderValue = (typeof PROVIDER_KEYS)[number];
export type RegionValue = Extract<
  OrganizationAIConfig,
  { configured: true }
>["providers"][number]["region"];
export type RoleValue = (typeof ROLE_KEYS)[number];

export type ProviderValidationStatus = "checking" | "valid" | "invalid";

export type ProviderPreview = {
  provider: ProviderValue;
  status: ProviderValidationStatus;
};

export type ProviderCredentialDraft = {
  provider: ProviderValue;
  apiKey: string;
  anthropicWorkspaceId?: string | undefined;
  apiKeyMasked?: string | undefined;
  endpoint: string;
  apiVersion?: string | undefined;
  region: RegionValue;
  replacingKey: boolean;
};

type ProviderCredentialChangesOptions = {
  draft: ProviderCredentialDraft;
  stored: ProviderCredentialDraft | undefined;
};

const normalizeWorkspaceId = (value: string | undefined) =>
  value?.trim() || undefined;

export const hasProviderCredentialChanges = ({
  draft,
  stored,
}: ProviderCredentialChangesOptions) =>
  draft.apiKey.length > 0 ||
  normalizeWorkspaceId(draft.anthropicWorkspaceId) !==
    normalizeWorkspaceId(stored?.anthropicWorkspaceId);

export type ModelSelection = {
  provider: ProviderValue;
  modelId: string;
};

export type RoleModelSelections = Record<RoleValue, ModelSelection | null>;
export type RoleModelOverrides = Partial<
  Record<RoleValue, ModelSelection | null>
>;

type RoleModelsComparisonOptions = {
  current: RoleModelOverrides;
  baseline: RoleModelOverrides;
};

export const haveSameRoleModelSelections = ({
  current,
  baseline,
}: RoleModelsComparisonOptions): boolean =>
  ROLE_KEYS.every((role) => {
    const selection = current[role];
    const saved = baseline[role];
    if (
      selection === undefined ||
      selection === null ||
      saved === undefined ||
      saved === null
    ) {
      return selection === saved;
    }
    return (
      selection.provider === saved.provider &&
      selection.modelId === saved.modelId
    );
  });

export type ModelOption = ModelSelection & {
  value: string;
};

export type StoredProviderConfig = {
  anthropicWorkspaceId?: string | undefined;
  provider: string;
  apiKeyMasked?: string | undefined;
  endpoint?: string | undefined;
  apiVersion?: string | undefined;
  region?: string | undefined;
};

export type StoredOverrideModels =
  | Partial<
      Record<
        RoleValue,
        | { provider?: string | undefined; modelId?: string | undefined }
        | null
        | undefined
      >
    >
  | null
  | undefined;

export type SerializedProviderConfig = {
  anthropicWorkspaceId?: string;
  provider: ProviderValue;
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
  region: RegionValue;
};

// Catalog data is the single source of truth in @stll/ai-catalog,
// shared with the API runtime. The `satisfies` guards also cross-check
// that the package's provider/role sets still match the UI's
// ProviderValue/RoleValue — a divergence fails typecheck here.
export const DEFAULT_MODELS_BY_PROVIDER = BYOK_DEFAULT_MODELS satisfies Record<
  ProviderValue,
  Record<
    RoleValue,
    | { kind: "default"; modelId: string; rationaleKey: TranslationKey }
    | { kind: "unsupported" }
  >
>;

export const MODEL_OPTIONS_BY_PROVIDER = BYOK_MODEL_OPTIONS satisfies Record<
  ProviderValue,
  readonly string[]
>;

export const isProviderRoleSupported = (
  provider: ProviderValue,
  role: RoleValue,
): boolean => isBYOKProviderRoleSupported({ provider, role });

export const getModelOptionsForRole = ({
  provider,
  role,
}: {
  provider: ProviderValue;
  role: RoleValue;
}): readonly string[] => {
  if (!isProviderRoleSupported(provider, role)) {
    return [];
  }
  return MODEL_OPTIONS_BY_PROVIDER[provider].filter((modelId) =>
    isBYOKModelRoleSupported({ provider, modelId, role }),
  );
};

export const isProviderValue = (value: string | null): value is ProviderValue =>
  value !== null && PROVIDER_KEYS.some((provider) => provider === value);

export const isRoleValue = (value: string): value is RoleValue =>
  ROLE_KEYS.some((role) => role === value);

export const createProviderCredentialDraft = (
  provider: ProviderValue = "google",
): ProviderCredentialDraft => ({
  provider,
  apiKey: "",
  endpoint: "",
  region: "global",
  replacingKey: true,
});

export const providerDraftsFromStoredProviders = (
  providers: readonly StoredProviderConfig[] | undefined,
): ProviderCredentialDraft[] => {
  if (!providers || providers.length === 0) {
    return [createProviderCredentialDraft()];
  }

  const drafts: ProviderCredentialDraft[] = [];

  for (const providerConfig of providers) {
    if (!isProviderValue(providerConfig.provider)) {
      continue;
    }

    const provider = providerConfig.provider;

    drafts.push({
      provider,
      apiKey: "",
      apiKeyMasked: providerConfig.apiKeyMasked,
      anthropicWorkspaceId: providerConfig.anthropicWorkspaceId,
      endpoint: providerConfig.endpoint ?? "",
      apiVersion: providerConfig.apiVersion,
      region:
        providerConfig.region === "eu" || providerConfig.region === "ch"
          ? providerConfig.region
          : "global",
      replacingKey: false,
    });
  }

  return drafts.length > 0 ? drafts : [createProviderCredentialDraft()];
};

export const createDefaultRoleModels = (
  providers: readonly ProviderValue[] = ["google"],
): RoleModelSelections => ({
  chat: getDefaultModelSelection(
    getDefaultProviderForRole(providers, "chat"),
    "chat",
  ),
  fast: getDefaultModelSelection(
    getDefaultProviderForRole(providers, "fast"),
    "fast",
  ),
  reasoning: getDefaultModelSelection(
    getDefaultProviderForRole(providers, "reasoning"),
    "reasoning",
  ),
  pdf: getDefaultModelSelection(
    getDefaultProviderForRole(providers, "pdf"),
    "pdf",
  ),
});

export const roleModelsFromOverrideModels = ({
  overrideModels,
  providers,
}: {
  overrideModels: StoredOverrideModels;
  providers: readonly ProviderValue[];
}): RoleModelSelections => {
  const models = createDefaultRoleModels(providers);

  if (!overrideModels) {
    return models;
  }

  const providerSet = new Set(providers);

  for (const role of ROLE_KEYS) {
    const selection = overrideModels[role];
    if (selection === null) {
      models[role] = null;
      continue;
    }
    if (
      selection?.provider &&
      selection.modelId &&
      isProviderValue(selection.provider) &&
      providerSet.has(selection.provider) &&
      isProviderRoleSupported(selection.provider, role)
    ) {
      models[role] = {
        provider: selection.provider,
        modelId: selection.modelId,
      };
    }
  }

  return models;
};

export const ensureRoleModelsForProviders = ({
  providers,
  roleModels,
}: {
  providers: readonly ProviderValue[];
  roleModels: RoleModelSelections;
}): RoleModelSelections => {
  const configuredProviders = new Set(providers);
  const nextModels = createDefaultRoleModels(providers);

  for (const role of ROLE_KEYS) {
    const selection = roleModels[role];
    if (
      selection &&
      configuredProviders.has(selection.provider) &&
      isProviderRoleSupported(selection.provider, role)
    ) {
      nextModels[role] = selection;
    }
  }

  return nextModels;
};

export const roleOverridesFromStoredModels = ({
  overrideModels,
  providers,
}: {
  overrideModels: StoredOverrideModels;
  providers: readonly ProviderValue[];
}): RoleModelOverrides => {
  const entries: [RoleValue, ModelSelection][] = [];
  for (const role of ROLE_KEYS) {
    const selection = overrideModels?.[role];
    if (
      selection?.provider &&
      selection.modelId &&
      isProviderValue(selection.provider) &&
      providers.includes(selection.provider) &&
      isProviderRoleSupported(selection.provider, role)
    ) {
      entries.push([
        role,
        { provider: selection.provider, modelId: selection.modelId },
      ]);
    }
  }
  return Object.fromEntries(entries);
};

export const serializeRoleOverrides = ({
  providers,
  overrides,
}: {
  providers: readonly ProviderValue[];
  overrides: RoleModelOverrides;
}) => {
  const entries: [RoleValue, ModelSelection][] = [];
  for (const role of ROLE_KEYS) {
    if (!Object.hasOwn(overrides, role)) {
      continue;
    }
    const selection = overrides[role];
    if (
      !selection ||
      !providers.includes(selection.provider) ||
      !isKnownModelSelectionForRole({ selection, role })
    ) {
      return { kind: "invalid" } as const;
    }
    entries.push([role, normalizeModelSelection(selection)]);
  }
  return {
    kind: "valid",
    overrides: entries.length === 0 ? null : Object.fromEntries(entries),
  } as const;
};

export const retainRoleOverridesForProviders = ({
  providers,
  overrides,
}: {
  providers: readonly ProviderValue[];
  overrides: RoleModelOverrides;
}): RoleModelOverrides => {
  const entries: [RoleValue, ModelSelection | null][] = [];
  for (const role of ROLE_KEYS) {
    const selection = overrides[role];
    if (selection === undefined) {
      continue;
    }
    if (selection === null) {
      if (
        providers.some((provider) => isProviderRoleSupported(provider, role))
      ) {
        entries.push([role, null]);
      }
      continue;
    }
    if (
      providers.includes(selection.provider) &&
      isProviderRoleSupported(selection.provider, role)
    ) {
      entries.push([role, selection]);
    }
  }
  return Object.fromEntries(entries);
};

export const encodeModelSelection = ({
  provider,
  modelId,
}: ModelSelection): string => `${provider}::${modelId}`;

export const decodeModelSelection = (value: string): ModelSelection | null => {
  const [providerRaw, ...modelParts] = value.split("::");
  const modelId = modelParts.join("::");

  if (!providerRaw || !isProviderValue(providerRaw) || !modelId) {
    return null;
  }

  return { provider: providerRaw, modelId };
};

export const getAvailableModelOptions = (
  providers: readonly ProviderValue[],
  role?: RoleValue,
): ModelOption[] => {
  const options: ModelOption[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    const modelOptions = role
      ? getModelOptionsForRole({ provider, role })
      : MODEL_OPTIONS_BY_PROVIDER[provider];
    for (const modelId of modelOptions) {
      const option = {
        provider,
        modelId,
      };
      const value = encodeModelSelection(option);
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      options.push({ ...option, value });
    }
  }

  return options;
};

export const getRolePickerRows = ({
  providers,
  roleModels,
}: {
  providers: readonly ProviderValue[];
  roleModels: RoleModelSelections;
}) =>
  ROLE_KEYS.map((role) => ({
    modelOptions: getAvailableModelOptions(providers, role),
    role,
    selection: roleModels[role],
    value: roleModels[role] ? encodeModelSelection(roleModels[role]) : "",
  }));

export const isKnownModelSelection = (
  selection: ModelSelection | null,
): boolean => {
  if (!selection) {
    return false;
  }
  const knownModels: readonly string[] =
    MODEL_OPTIONS_BY_PROVIDER[selection.provider];
  return knownModels.includes(selection.modelId);
};

export const isKnownModelSelectionForRole = ({
  selection,
  role,
}: {
  selection: ModelSelection | null;
  role: RoleValue;
}): boolean => {
  if (!selection) {
    return false;
  }
  const knownModels = getModelOptionsForRole({
    provider: selection.provider,
    role,
  });
  return knownModels.includes(selection.modelId);
};

export const serializeOverrideModels = ({
  providers,
  roleModels,
}: {
  providers: readonly ProviderValue[];
  roleModels: RoleModelSelections;
}): Record<RoleValue, ModelSelection> | null => {
  if (providers.length === 0) {
    return null;
  }

  const chat = roleModels.chat;
  const fast = roleModels.fast;
  const reasoning = roleModels.reasoning;
  const pdf = roleModels.pdf;

  if (!(chat && fast && reasoning && pdf)) {
    return null;
  }

  const selections = { chat, fast, reasoning, pdf } satisfies Record<
    RoleValue,
    ModelSelection
  >;
  const providerSet = new Set(providers);
  for (const role of ROLE_KEYS) {
    const selection = selections[role];
    if (
      !providerSet.has(selection.provider) ||
      !isKnownModelSelectionForRole({ selection, role })
    ) {
      return null;
    }
  }

  return {
    chat: normalizeModelSelection(chat),
    fast: normalizeModelSelection(fast),
    reasoning: normalizeModelSelection(reasoning),
    pdf: normalizeModelSelection(pdf),
  };
};

export const getAvailableProviderKeys = ({
  currentProvider,
  providers,
}: {
  currentProvider?: ProviderValue | undefined;
  providers: readonly ProviderCredentialDraft[];
}): ProviderValue[] => {
  const usedProviders = new Set<ProviderValue>();
  for (const providerDraft of providers) {
    if (providerDraft.provider !== currentProvider) {
      usedProviders.add(providerDraft.provider);
    }
  }

  return PROVIDER_KEYS.filter((provider) => !usedProviders.has(provider));
};

export const getProviderValues = (
  providers: readonly ProviderCredentialDraft[],
): ProviderValue[] => providers.map((providerDraft) => providerDraft.provider);

export const serializeProviderDrafts = (
  providers: readonly ProviderCredentialDraft[],
): SerializedProviderConfig[] => {
  const serializedProviders: SerializedProviderConfig[] = [];

  for (const providerDraft of providers) {
    const apiKey = providerDraft.apiKey.trim();
    serializedProviders.push({
      provider: providerDraft.provider,
      ...(apiKey ? { apiKey } : {}),
      ...(providerDraft.provider === "anthropic" &&
      providerDraft.anthropicWorkspaceId !== undefined
        ? { anthropicWorkspaceId: providerDraft.anthropicWorkspaceId.trim() }
        : {}),
      region: providerDraft.region,
    });
  }

  return serializedProviders;
};

export const getNextAvailableProvider = (
  providers: readonly ProviderCredentialDraft[],
): ProviderValue | null =>
  PROVIDER_KEYS.find(
    (provider) =>
      !providers.some((providerDraft) => providerDraft.provider === provider),
  ) ?? null;

export const hasUsableProviderDrafts = (
  providers: readonly ProviderCredentialDraft[],
): boolean => {
  if (providers.length === 0) {
    return false;
  }

  const seenProviders = new Set<ProviderValue>();

  for (const providerDraft of providers) {
    if (seenProviders.has(providerDraft.provider)) {
      return false;
    }
    seenProviders.add(providerDraft.provider);

    if (
      (providerDraft.replacingKey || !providerDraft.apiKeyMasked) &&
      !providerDraft.apiKey.trim()
    ) {
      return false;
    }
  }

  return true;
};

export const getDefaultModelSelection = (
  provider: ProviderValue | undefined,
  role: RoleValue,
): ModelSelection | null => {
  if (!provider) {
    return null;
  }
  const entry = DEFAULT_MODELS_BY_PROVIDER[provider][role];
  if (entry.kind === "unsupported") {
    return null;
  }
  return { provider, modelId: entry.modelId };
};

const getDefaultProviderForRole = (
  providers: readonly ProviderValue[],
  role: RoleValue,
): ProviderValue | undefined =>
  providers.find(
    (provider) => DEFAULT_MODELS_BY_PROVIDER[provider][role].kind === "default",
  );

const normalizeModelSelection = ({
  provider,
  modelId,
}: ModelSelection): ModelSelection => ({
  provider,
  modelId,
});

/**
 * The decision model: a non-generative model that answers typed questions
 * (a choice from N, yes/no, a score) with probabilities. It sits beside the
 * generative roles with its own provider and key, and merges on its own terms:
 * an absent field keeps what is stored, `null` clears it, an object replaces it.
 */

type ConfiguredAIConfig = Extract<OrganizationAIConfig, { configured: true }>;

/** The stored decision model, as `GET /ai-config` reports it. */
export type StoredDecisionModel = NonNullable<ConfiguredAIConfig["decision"]>;

export const DECISION_PROVIDER_KEYS =
  DECISION_MODEL_PROVIDERS satisfies readonly StoredDecisionModel["provider"][];

export type DecisionProviderValue = (typeof DECISION_PROVIDER_KEYS)[number];

// A provider the API accepts but this list never offers would be unreachable
// from settings; the divergence fails typecheck here instead of going unseen.
type UnofferedDecisionProvider = Exclude<
  StoredDecisionModel["provider"],
  DecisionProviderValue
>;

true satisfies UnofferedDecisionProvider extends never ? true : never;

export type DecisionModelState =
  | { kind: "untouched" }
  | { kind: "cleared" }
  | {
      kind: "set";
      provider: DecisionProviderValue;
      apiKey: string;
      modelId: string;
    };

/** The save body's `decision` field: absent keeps, null clears, object sets. */
type SerializedDecisionModel =
  | { provider: DecisionProviderValue; apiKey?: string; modelId: string }
  | null
  | undefined;

export const serializeDecisionModel = (
  state: DecisionModelState,
): SerializedDecisionModel => {
  switch (state.kind) {
    case "untouched":
      return undefined;
    case "cleared":
      return null;
    case "set": {
      // An empty input is the "keep the stored key" signal, so the field is
      // omitted rather than sent as a blank string the API would reject.
      const apiKey = state.apiKey.trim();
      return {
        provider: state.provider,
        ...(apiKey ? { apiKey } : {}),
        modelId: state.modelId.trim(),
      };
    }
    default:
      state satisfies never;
      return panic("Unhandled decision model state");
  }
};

type DecisionModelDraft = {
  provider: DecisionProviderValue;
  apiKey: string;
  /** Masked stored key, present only while a key is stored for this provider. */
  apiKeyMasked?: string | undefined;
  modelId: string;
};

type DecisionModelViewOptions = {
  state: DecisionModelState;
  stored: StoredDecisionModel | null | undefined;
};

/** What the section renders: the edited draft, or null when there is none. */
export const decisionModelDraft = ({
  state,
  stored,
}: DecisionModelViewOptions): DecisionModelDraft | null => {
  switch (state.kind) {
    case "untouched":
      return stored
        ? {
            provider: stored.provider,
            apiKey: "",
            apiKeyMasked: stored.apiKeyMasked,
            modelId: stored.modelId,
          }
        : null;
    case "cleared":
      return null;
    case "set":
      return {
        provider: state.provider,
        apiKey: state.apiKey,
        // A stored key belongs to the provider it was issued for, so switching
        // provider must not present it as reusable.
        ...(stored?.provider === state.provider
          ? { apiKeyMasked: stored.apiKeyMasked }
          : {}),
        modelId: state.modelId,
      };
    default:
      state satisfies never;
      return panic("Unhandled decision model state");
  }
};

export const createDecisionModelState = (
  provider: DecisionProviderValue = "typesafe",
): DecisionModelState => ({
  kind: "set",
  provider,
  apiKey: "",
  modelId: DECISION_MODEL_CATALOG[provider].defaultModelId,
});

/** A set decision model needs a model id and a key, typed now or stored before. */
export const hasUsableDecisionModel = ({
  state,
  stored,
}: DecisionModelViewOptions): boolean => {
  if (state.kind !== "set") {
    return true;
  }
  if (!state.modelId.trim()) {
    return false;
  }
  return state.apiKey.trim().length > 0 || stored?.provider === state.provider;
};
