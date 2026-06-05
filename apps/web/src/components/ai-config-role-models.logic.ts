import { BYOK_DEFAULT_MODELS, BYOK_MODEL_OPTIONS } from "@stll/ai-catalog";

export const PROVIDER_KEYS = [
  "google",
  "anthropic",
  "mistral",
  "openai",
  "azure_foundry",
  "openrouter",
  "huggingface",
] as const;

export const PROVIDER_LABELS = {
  google: "Google",
  anthropic: "Anthropic",
  mistral: "Mistral",
  openai: "OpenAI",
  azure_foundry: "Azure Foundry",
  openrouter: "OpenRouter",
  huggingface: "Hugging Face",
} as const satisfies Record<(typeof PROVIDER_KEYS)[number], string>;

export const REGION_KEYS = ["global", "eu", "ch"] as const;

export const ROLE_KEYS = ["chat", "fast", "reasoning", "pdf"] as const;

export type ProviderValue = (typeof PROVIDER_KEYS)[number];
export type RegionValue = (typeof REGION_KEYS)[number];
export type RoleValue = (typeof ROLE_KEYS)[number];

export type ProviderValidationStatus = "checking" | "valid" | "invalid";

export type ProviderPreview = {
  provider: ProviderValue;
  status: ProviderValidationStatus;
};

export type ProviderCredentialDraft = {
  provider: ProviderValue;
  apiKey: string;
  apiKeyMasked?: string | undefined;
  endpoint: string;
  apiVersion?: string | undefined;
  region: RegionValue;
  replacingKey: boolean;
};

export type ModelSelection = {
  provider: ProviderValue;
  modelId: string;
};

export type RoleModelSelections = Record<RoleValue, ModelSelection | null>;

export type ModelOption = ModelSelection & {
  value: string;
};

export type StoredProviderConfig = {
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
        | undefined
      >
    >
  | null
  | undefined;

export type SerializedProviderConfig = {
  provider: ProviderValue;
  apiKey?: string;
  endpoint?: string;
  apiVersion?: string;
  region: RegionValue;
};

const PROVIDER_VALUES = new Set<string>(PROVIDER_KEYS);
const REGION_VALUES = new Set<string>(REGION_KEYS);
const ROLE_VALUES = new Set<string>(ROLE_KEYS);

export const REGIONAL_PROVIDERS = new Set<ProviderValue>(["google"]);
export const CUSTOM_MODEL_ID_PROVIDERS = new Set<ProviderValue>([
  "azure_foundry",
  "huggingface",
]);
export const ENDPOINT_REQUIRED_PROVIDERS = new Set<ProviderValue>([
  "azure_foundry",
  "huggingface",
]);

// Catalog data is the single source of truth in @stll/ai-catalog,
// shared with the API runtime. The `satisfies` guards also cross-check
// that the package's provider/role sets still match the UI's
// ProviderValue/RoleValue — a divergence fails typecheck here.
export const DEFAULT_MODELS_BY_PROVIDER = BYOK_DEFAULT_MODELS satisfies Partial<
  Record<ProviderValue, Record<RoleValue, string>>
>;

export const MODEL_OPTIONS_BY_PROVIDER = BYOK_MODEL_OPTIONS satisfies Record<
  ProviderValue,
  readonly string[]
>;

export const isProviderValue = (value: string | null): value is ProviderValue =>
  value !== null && PROVIDER_VALUES.has(value);

export const isRegionValue = (value: string | null): value is RegionValue =>
  value !== null && REGION_VALUES.has(value);

export const isRoleValue = (value: string): value is RoleValue =>
  ROLE_VALUES.has(value);

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
    const storedRegion = providerConfig.region;
    let region: RegionValue = "global";
    if (
      storedRegion &&
      isRegionValue(storedRegion) &&
      REGIONAL_PROVIDERS.has(provider)
    ) {
      region = storedRegion;
    }

    drafts.push({
      provider,
      apiKey: "",
      apiKeyMasked: providerConfig.apiKeyMasked,
      endpoint: providerConfig.endpoint ?? "",
      apiVersion: providerConfig.apiVersion,
      region,
      replacingKey: false,
    });
  }

  return drafts.length > 0 ? drafts : [createProviderCredentialDraft()];
};

export const createDefaultRoleModels = (
  providers: readonly ProviderValue[] = ["google"],
): RoleModelSelections => {
  const provider = providers.at(0);
  return {
    chat: getDefaultModelSelection(provider, "chat"),
    fast: getDefaultModelSelection(provider, "fast"),
    reasoning: getDefaultModelSelection(provider, "reasoning"),
    pdf: getDefaultModelSelection(provider, "pdf"),
  };
};

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
    if (
      selection?.provider &&
      selection.modelId &&
      isProviderValue(selection.provider) &&
      providerSet.has(selection.provider)
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
    if (selection && configuredProviders.has(selection.provider)) {
      nextModels[role] = selection;
    }
  }

  return nextModels;
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
): ModelOption[] => {
  const options: ModelOption[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    for (const modelId of MODEL_OPTIONS_BY_PROVIDER[provider]) {
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
}) => {
  const options = getAvailableModelOptions(providers);

  return ROLE_KEYS.map((role) => ({
    modelOptions: options,
    role,
    selection: roleModels[role],
    value: roleModels[role] ? encodeModelSelection(roleModels[role]) : "",
  }));
};

export const isKnownModelSelection = (
  selection: ModelSelection | null,
): boolean => {
  if (!selection) {
    return false;
  }
  const knownModels: readonly string[] =
    MODEL_OPTIONS_BY_PROVIDER[selection.provider];
  if (CUSTOM_MODEL_ID_PROVIDERS.has(selection.provider)) {
    return selection.modelId.trim().length > 0;
  }
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

  const selections = [chat, fast, reasoning, pdf];
  if (
    selections.some(
      (selection) =>
        !providers.includes(selection.provider) ||
        !isKnownModelSelection(selection),
    )
  ) {
    return null;
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
      ...(ENDPOINT_REQUIRED_PROVIDERS.has(providerDraft.provider)
        ? { endpoint: providerDraft.endpoint.trim() }
        : {}),
      ...(providerDraft.provider === "azure_foundry" && providerDraft.apiVersion
        ? { apiVersion: providerDraft.apiVersion }
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
    if (
      ENDPOINT_REQUIRED_PROVIDERS.has(providerDraft.provider) &&
      !providerDraft.endpoint.trim()
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
  if (provider === "azure_foundry" || provider === "huggingface") {
    return null;
  }
  const defaults = DEFAULT_MODELS_BY_PROVIDER[provider];
  return {
    provider,
    modelId: defaults[role],
  };
};

const normalizeModelSelection = ({
  provider,
  modelId,
}: ModelSelection): ModelSelection => ({
  provider,
  modelId: CUSTOM_MODEL_ID_PROVIDERS.has(provider) ? modelId.trim() : modelId,
});
