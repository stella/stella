export const PROVIDER_KEYS = [
  "google",
  "anthropic",
  "openai",
  "openrouter",
] as const;

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

const PROVIDER_VALUES = new Set<string>(PROVIDER_KEYS);
const REGION_VALUES = new Set<string>(REGION_KEYS);
const ROLE_VALUES = new Set<string>(ROLE_KEYS);

export const REGIONAL_PROVIDERS = new Set<ProviderValue>(["google"]);

export const DEFAULT_MODELS_BY_PROVIDER = {
  google: {
    chat: "gemini-3-flash-preview",
    fast: "gemini-2.5-flash-lite",
    reasoning: "gemini-3-pro-preview",
    pdf: "gemini-3-flash-preview",
  },
  anthropic: {
    chat: "claude-sonnet-4-6",
    fast: "claude-haiku-4-5-20251001",
    reasoning: "claude-sonnet-4-6",
    pdf: "claude-sonnet-4-6",
  },
  openai: {
    chat: "gpt-5.4-mini",
    fast: "gpt-5.4-nano",
    reasoning: "gpt-5.4",
    pdf: "gpt-5.4",
  },
  openrouter: {
    chat: "google/gemini-3-flash-preview",
    fast: "google/gemini-2.5-flash-lite",
    reasoning: "google/gemini-3.1-pro-preview",
    pdf: "google/gemini-3-flash-preview",
  },
} as const satisfies Record<ProviderValue, Record<RoleValue, string>>;

export const MODEL_OPTIONS_BY_PROVIDER = {
  google: [
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  anthropic: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
  ],
  openai: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2"],
  openrouter: [
    "google/gemini-3-flash-preview",
    "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-flash-lite",
    "anthropic/claude-opus-4.5",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
  ],
} as const satisfies Record<ProviderValue, readonly string[]>;

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

  for (const role of ROLE_KEYS) {
    const selection = overrideModels[role];
    if (
      selection?.provider &&
      selection.modelId &&
      isProviderValue(selection.provider) &&
      providers.includes(selection.provider)
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

  // Reject orphan providers — every configured provider
  // must drive at least one role. Mirrors the API check;
  // gating it here keeps the save button honest.
  const referencedProviders = new Set(
    selections.map((selection) => selection.provider),
  );
  if (providers.some((provider) => !referencedProviders.has(provider))) {
    return null;
  }

  return {
    chat,
    fast,
    reasoning,
    pdf,
  };
};

export const getAvailableProviderKeys = ({
  currentProvider,
  providers,
}: {
  currentProvider?: ProviderValue | undefined;
  providers: readonly ProviderCredentialDraft[];
}): ProviderValue[] => {
  const usedProviders = new Set(
    providers
      .map((providerDraft) => providerDraft.provider)
      .filter((provider) => provider !== currentProvider),
  );

  return PROVIDER_KEYS.filter((provider) => !usedProviders.has(provider));
};

export const getProviderValues = (
  providers: readonly ProviderCredentialDraft[],
): ProviderValue[] => providers.map((providerDraft) => providerDraft.provider);

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
  return {
    provider,
    modelId: DEFAULT_MODELS_BY_PROVIDER[provider][role],
  };
};
