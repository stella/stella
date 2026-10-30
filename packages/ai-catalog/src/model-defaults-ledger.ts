import type {
  AIProvider,
  BYOKModelIdByProvider,
  BYOKProvider,
  ReasoningEffort,
  TemperaturePolicy,
} from "./index";

export const MODEL_TASKS = [
  "chat",
  "reasoning",
  "analysis",
  "pdf",
  "search-expand",
  "classify",
  "short-text",
] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

export const MODEL_OVERRIDE_GROUPS = [
  "fast",
  "chat",
  "reasoning",
  "pdf",
] as const;
export type ModelOverrideGroup = (typeof MODEL_OVERRIDE_GROUPS)[number];

export const MODEL_TASK_OVERRIDE_GROUP = {
  chat: "chat",
  reasoning: "reasoning",
  analysis: "chat",
  pdf: "pdf",
  "search-expand": "fast",
  classify: "fast",
  "short-text": "fast",
} as const satisfies Record<ModelTask, ModelOverrideGroup>;

export const MODEL_OVERRIDE_GROUP_TASK = {
  fast: "short-text",
  chat: "chat",
  reasoning: "reasoning",
  pdf: "pdf",
} as const satisfies Record<ModelOverrideGroup, ModelTask>;

/** A reasoning request is capability-clamped before it reaches the provider. */
export type ModelMode =
  | {
      type: "google-thinking";
      requestedEffort: ReasoningEffort;
      thinkingLevel: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
      temperaturePolicy: TemperaturePolicy;
    }
  | { type: "provider-default"; temperaturePolicy: TemperaturePolicy }
  | {
      type: "reasoning-effort";
      effort: ReasoningEffort;
      temperaturePolicy: TemperaturePolicy;
    }
  | {
      type: "anthropic-thinking";
      thinking:
        { type: "adaptive" } | { type: "enabled"; budget_tokens: number };
      temperaturePolicy: "omit";
    };

type ProviderModelMode<TProvider extends AIProvider> =
  TProvider extends "google"
    ? Extract<ModelMode, { type: "google-thinking" }>
    : TProvider extends "anthropic"
      ? Extract<ModelMode, { type: "provider-default" | "anthropic-thinking" }>
      : TProvider extends "openai" | "openrouter"
        ? Extract<ModelMode, { type: "provider-default" | "reasoning-effort" }>
        : Extract<ModelMode, { type: "provider-default" }>;

export type ModelDefaultCandidate<TProvider extends AIProvider = AIProvider> = {
  modelId: TProvider extends BYOKProvider
    ? BYOKModelIdByProvider[TProvider]
    : string;
  mode: ProviderModelMode<TProvider>;
};

export type ModelDefaultQuality =
  | {
      source: "seed";
      measurement:
        | { status: "unmeasured" }
        | {
            status: "different-mode";
            source: "external-benchmark";
            modelId: string;
            provider: AIProvider;
            measuredMode: ModelMode;
          };
    }
  | {
      source: "local-eval" | "same-weights" | "external-benchmark";
      measurement: {
        status: "matching-mode";
        modelId: string;
        provider: AIProvider;
        measuredMode: ModelMode;
      };
    };

export type ModelDefaultRationale = {
  rationaleKey: `organization.aiConfig.defaultRationale.${ModelOverrideGroup}`;
};

type SupportedModelDefaultEntry<TProvider extends AIProvider = AIProvider> = {
  kind: "candidate";
  candidate: ModelDefaultCandidate<TProvider>;
  quality: ModelDefaultQuality;
  rationale: ModelDefaultRationale;
};
type UnsupportedModelDefaultEntry = {
  kind: "unsupported";
  reason: "document-input-unsupported";
};
export type ModelDefaultEntry =
  SupportedModelDefaultEntry | UnsupportedModelDefaultEntry;

type TaskProviderDefaults<TTask extends ModelTask> = {
  [TProvider in AIProvider]: TTask extends "pdf"
    ? TProvider extends "mistral"
      ? UnsupportedModelDefaultEntry
      : SupportedModelDefaultEntry<TProvider>
    : SupportedModelDefaultEntry<TProvider>;
};
export type ModelDefaultsLedger = {
  [TTask in ModelTask]: TaskProviderDefaults<TTask>;
};

const PROVIDER_DEFAULT_OMIT_MODE = {
  type: "provider-default",
  temperaturePolicy: "omit",
} as const satisfies ModelMode;
const PROVIDER_DEFAULT_EMIT_MODE = {
  type: "provider-default",
  temperaturePolicy: "emit",
} as const satisfies ModelMode;
const GOOGLE_FLASH_NONE_MODE = {
  type: "google-thinking",
  requestedEffort: "none",
  thinkingLevel: "LOW",
  temperaturePolicy: "omit",
} as const satisfies ModelMode;
const GOOGLE_FLASH_HIGH_MODE = {
  type: "google-thinking",
  requestedEffort: "high",
  thinkingLevel: "HIGH",
  temperaturePolicy: "omit",
} as const satisfies ModelMode;
const UNMEASURED_SEED_QUALITY = {
  source: "seed",
  measurement: { status: "unmeasured" },
} as const satisfies ModelDefaultQuality;

const DEFAULT_RATIONALE_BY_GROUP = {
  fast: { rationaleKey: "organization.aiConfig.defaultRationale.fast" },
  chat: { rationaleKey: "organization.aiConfig.defaultRationale.chat" },
  reasoning: {
    rationaleKey: "organization.aiConfig.defaultRationale.reasoning",
  },
  pdf: { rationaleKey: "organization.aiConfig.defaultRationale.pdf" },
} as const satisfies Record<ModelOverrideGroup, ModelDefaultRationale>;

const CHAT_DEFAULTS = {
  google: {
    kind: "candidate",
    candidate: {
      modelId: "gemini-3.8-flash",
      mode: GOOGLE_FLASH_NONE_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.chat,
  },
  openrouter: {
    kind: "candidate",
    candidate: {
      modelId: "openai/gpt-6-sol",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.chat,
  },
  openai: {
    kind: "candidate",
    candidate: {
      modelId: "gpt-6-sol",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.chat,
  },
  azure_foundry: {
    kind: "candidate",
    candidate: {
      modelId: "gpt-5.6-terra",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.chat,
  },
  anthropic: {
    kind: "candidate",
    candidate: {
      modelId: "claude-opus-5-5",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.chat,
  },
  bedrock: {
    kind: "candidate",
    candidate: {
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      mode: PROVIDER_DEFAULT_EMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.chat,
  },
  mistral: {
    kind: "candidate",
    candidate: {
      modelId: "mistral-medium-latest",
      mode: PROVIDER_DEFAULT_EMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.chat,
  },
  openai_compatible: {
    kind: "candidate",
    candidate: {
      modelId: "default",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.chat,
  },
  huggingface: {
    kind: "candidate",
    candidate: {
      modelId: "speakleash/Bielik-11B-v2.3-Instruct",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.chat,
  },
} as const satisfies TaskProviderDefaults<"chat">;

const REASONING_DEFAULTS = {
  google: {
    kind: "candidate",
    candidate: {
      modelId: "gemini-3.8-flash",
      mode: GOOGLE_FLASH_HIGH_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.reasoning,
  },
  openrouter: {
    kind: "candidate",
    candidate: {
      modelId: "openai/gpt-6-sol",
      mode: {
        type: "reasoning-effort",
        effort: "high",
        temperaturePolicy: "omit",
      },
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.reasoning,
  },
  openai: {
    kind: "candidate",
    candidate: {
      modelId: "gpt-6-sol",
      mode: {
        type: "reasoning-effort",
        effort: "medium",
        temperaturePolicy: "omit",
      },
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.reasoning,
  },
  azure_foundry: {
    kind: "candidate",
    candidate: {
      modelId: "gpt-5.6-terra",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.reasoning,
  },
  anthropic: {
    kind: "candidate",
    candidate: {
      modelId: "claude-opus-5-5",
      mode: {
        type: "anthropic-thinking",
        thinking: { type: "adaptive" },
        temperaturePolicy: "omit",
      },
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.reasoning,
  },
  bedrock: {
    kind: "candidate",
    candidate: {
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      mode: PROVIDER_DEFAULT_EMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.reasoning,
  },
  mistral: {
    kind: "candidate",
    candidate: {
      modelId: "mistral-medium-latest",
      mode: PROVIDER_DEFAULT_EMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.reasoning,
  },
  openai_compatible: {
    kind: "candidate",
    candidate: {
      modelId: "default",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.reasoning,
  },
  huggingface: {
    kind: "candidate",
    candidate: {
      modelId: "speakleash/Bielik-11B-v2.3-Instruct",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.reasoning,
  },
} as const satisfies TaskProviderDefaults<"reasoning">;

const PDF_DEFAULTS = {
  google: {
    kind: "candidate",
    candidate: {
      modelId: "gemini-3.8-flash",
      mode: GOOGLE_FLASH_NONE_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.pdf,
  },
  openrouter: {
    kind: "candidate",
    candidate: {
      modelId: "openai/gpt-6-sol",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.pdf,
  },
  openai: {
    kind: "candidate",
    candidate: {
      modelId: "gpt-6-sol",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.pdf,
  },
  azure_foundry: {
    kind: "candidate",
    candidate: {
      modelId: "gpt-5.6-terra",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.pdf,
  },
  anthropic: {
    kind: "candidate",
    candidate: {
      modelId: "claude-opus-5-5",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.pdf,
  },
  bedrock: {
    kind: "candidate",
    candidate: {
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      mode: PROVIDER_DEFAULT_EMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.pdf,
  },
  mistral: { kind: "unsupported", reason: "document-input-unsupported" },
  openai_compatible: {
    kind: "candidate",
    candidate: {
      modelId: "default",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.pdf,
  },
  huggingface: {
    kind: "candidate",
    candidate: {
      modelId: "speakleash/Bielik-11B-v2.3-Instruct",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.pdf,
  },
} as const satisfies TaskProviderDefaults<"pdf">;

const FAST_DEFAULTS = {
  google: {
    kind: "candidate",
    candidate: {
      modelId: "gemini-3.8-flash",
      mode: GOOGLE_FLASH_NONE_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.fast,
  },
  openrouter: {
    kind: "candidate",
    candidate: {
      modelId: "anthropic/claude-haiku-5.5",
      mode: {
        type: "reasoning-effort",
        effort: "none",
        temperaturePolicy: "omit",
      },
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.fast,
  },
  openai: {
    kind: "candidate",
    candidate: {
      modelId: "gpt-6-luna",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.fast,
  },
  azure_foundry: {
    kind: "candidate",
    candidate: {
      modelId: "gpt-5.6-luna",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.fast,
  },
  anthropic: {
    kind: "candidate",
    candidate: {
      modelId: "claude-haiku-5-5",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.fast,
  },
  bedrock: {
    kind: "candidate",
    candidate: {
      modelId: "us.anthropic.claude-haiku-5-5",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.fast,
  },
  mistral: {
    kind: "candidate",
    candidate: {
      modelId: "mistral-small-latest",
      mode: PROVIDER_DEFAULT_EMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.fast,
  },
  openai_compatible: {
    kind: "candidate",
    candidate: {
      modelId: "default",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.fast,
  },
  huggingface: {
    kind: "candidate",
    candidate: {
      modelId: "speakleash/Bielik-1.5B-v3.0-Instruct",
      mode: PROVIDER_DEFAULT_OMIT_MODE,
    },
    quality: UNMEASURED_SEED_QUALITY,
    rationale: DEFAULT_RATIONALE_BY_GROUP.fast,
  },
} as const satisfies TaskProviderDefaults<"short-text">;

export const MODEL_DEFAULTS_LEDGER = {
  chat: CHAT_DEFAULTS,
  reasoning: REASONING_DEFAULTS,
  analysis: CHAT_DEFAULTS,
  pdf: PDF_DEFAULTS,
  "search-expand": FAST_DEFAULTS,
  classify: FAST_DEFAULTS,
  "short-text": FAST_DEFAULTS,
} as const satisfies ModelDefaultsLedger;

export type ResolvedDefaultModel<TProvider extends AIProvider = AIProvider> = {
  provider: TProvider;
  modelId: string;
  mode: ModelMode;
};

type ResolveDefaultModelOptions<TProvider extends AIProvider> = {
  task: ModelTask;
  orgProviders: readonly TProvider[];
};

/** Seeded defaults preserve the configured provider order. */
export const resolveDefaultModel = <TProvider extends AIProvider>({
  task,
  orgProviders,
}: ResolveDefaultModelOptions<TProvider>): ResolvedDefaultModel<TProvider> | null => {
  for (const provider of orgProviders) {
    const entry = MODEL_DEFAULTS_LEDGER[task][provider];
    if (entry.kind === "candidate") {
      return {
        provider,
        modelId: entry.candidate.modelId,
        mode: entry.candidate.mode,
      };
    }
  }
  return null;
};

const defaultSelection = <TProvider extends AIProvider>(
  selection: ResolvedDefaultModel<TProvider> | null,
) =>
  selection === null
    ? null
    : { provider: selection.provider, modelId: selection.modelId };

/** Settings groups are a presentation of task defaults, not a second selection policy. */
export const resolveDefaultOverrideModels = <TProvider extends AIProvider>(
  orgProviders: readonly TProvider[],
) =>
  ({
    fast: defaultSelection(
      resolveDefaultModel({
        task: MODEL_OVERRIDE_GROUP_TASK.fast,
        orgProviders,
      }),
    ),
    chat: defaultSelection(
      resolveDefaultModel({
        task: MODEL_OVERRIDE_GROUP_TASK.chat,
        orgProviders,
      }),
    ),
    reasoning: defaultSelection(
      resolveDefaultModel({
        task: MODEL_OVERRIDE_GROUP_TASK.reasoning,
        orgProviders,
      }),
    ),
    pdf: defaultSelection(
      resolveDefaultModel({
        task: MODEL_OVERRIDE_GROUP_TASK.pdf,
        orgProviders,
      }),
    ),
  }) satisfies Record<
    ModelOverrideGroup,
    { provider: TProvider; modelId: string } | null
  >;
