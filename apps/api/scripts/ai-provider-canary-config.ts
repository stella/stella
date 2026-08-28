import {
  BYOK_MODEL_OPTIONS,
  DEFAULT_MODELS,
  isBYOKModelRoleSupported,
  MODEL_ROLES,
} from "@stll/ai-catalog";
import type { ModelRole } from "@stll/ai-catalog";

import type { TanStackTextProvider } from "@/api/lib/tanstack-ai-models";

const defineCanaryProviders = <
  const TProviders extends readonly TanStackTextProvider[],
>(
  providers: TProviders &
    ([TanStackTextProvider] extends [TProviders[number]] ? unknown : never),
): TProviders => providers;

export const CANARY_PROVIDERS = defineCanaryProviders([
  "google",
  "openrouter",
  "openai",
  "anthropic",
  "bedrock",
  "mistral",
]);

export type CanaryProvider = (typeof CANARY_PROVIDERS)[number];
export type CanaryProviderSelection = "all" | CanaryProvider;

// A provider addition must make an explicit decision here: silently treating a
// new strict adapter as omission-preserving would make its canary prompt invalid.
const CANARY_PROVIDER_NULL_WIDENING = {
  google: false,
  openrouter: false,
  openai: true,
  anthropic: false,
  bedrock: false,
  mistral: true,
} as const satisfies Record<CanaryProvider, boolean>;

// Providers whose strict/structured tool-calling mode forces every optional
// property to be present, widening it to accept a synthetic `null` in place
// of true omission. Both the flat round-trip probe and the weekly tool-shape
// probes ask these providers for that null explicitly (deterministically)
// instead of leaving them to guess omission vs. hallucination (#1194/#1196).
export const NULL_WIDENING_CANARY_PROVIDERS = new Set(
  CANARY_PROVIDERS.filter(
    (provider) => CANARY_PROVIDER_NULL_WIDENING[provider],
  ),
);

// JSON Schema patterns have no regex flag channel. OpenAI strict Structured
// Outputs supports `pattern`; `a^` cannot match any string. Used to make the
// "omit or send this impossible value" duality deterministic: no real string
// can validly satisfy the optional field, only omission (or, for
// null-widening providers, the synthetic null their strict mode forces).
// eslint-disable-next-line require-unicode-regexp
export const NEVER_MATCH_PATTERN = /a^/;

export const CANARY_TIERS = ["daily", "weekly"] as const;
export type CanaryTier = (typeof CANARY_TIERS)[number];

export const WEEKLY_TOOL_SHAPES = [
  "nested-optional",
  "array-item-optional",
  "open-map",
  "discriminated-union",
] as const;
export type WeeklyToolShape = (typeof WEEKLY_TOOL_SHAPES)[number];

export type WeeklyCanaryRotation = {
  modelId: string;
  modelRoles: ModelRole[];
  rotationIndex: number;
  toolShape: WeeklyToolShape;
};

type WeeklyCanaryRotationOptions = {
  provider: CanaryProvider;
  rotationIndex: number;
};

export const weeklyCanaryRotation = ({
  provider,
  rotationIndex,
}: WeeklyCanaryRotationOptions): WeeklyCanaryRotation => {
  if (!Number.isSafeInteger(rotationIndex) || rotationIndex < 0) {
    throw new TypeError("Weekly canary rotation index must be non-negative.");
  }

  const models = BYOK_MODEL_OPTIONS[provider];
  const modelId = models.at(rotationIndex % models.length);
  const toolShape = WEEKLY_TOOL_SHAPES.at(
    rotationIndex % WEEKLY_TOOL_SHAPES.length,
  );
  if (modelId === undefined || toolShape === undefined) {
    throw new TypeError("Weekly canary rotation catalog must not be empty.");
  }

  const supportedRoles = MODEL_ROLES.filter((role) =>
    isBYOKModelRoleSupported({ modelId, provider, role }),
  );
  if (supportedRoles.length === 0) {
    throw new TypeError(
      `Weekly canary model ${modelId} has no supported role.`,
    );
  }

  const nonDefaultRoles = supportedRoles.filter(
    (role) => DEFAULT_MODELS[provider][role] !== modelId,
  );
  const modelRoles =
    nonDefaultRoles.length > 0 ? nonDefaultRoles : supportedRoles;

  return { modelId, modelRoles, rotationIndex, toolShape };
};

const MODEL_ROLE_MAX_OUTPUT_TOKENS = {
  fast: 512,
  chat: 512,
  reasoning: 25_000,
  pdf: 512,
} as const satisfies Record<ModelRole, number>;

export const modelRoleMaxOutputTokens = (role: ModelRole) =>
  MODEL_ROLE_MAX_OUTPUT_TOKENS[role];

// Anthropic's SDK rejects non-streaming structured-output requests whose
// ceiling can exceed its ten-minute window. Keep the reasoning probe below
// the adapter's documented ~21K clamp while leaving streaming probes intact.
export const structuredOutputModelRoleMaxOutputTokens = (role: ModelRole) =>
  role === "reasoning" ? 20_000 : modelRoleMaxOutputTokens(role);

// Tool-execution probes pay for a model's thinking tokens out of the same
// output budget as the tool call. The chat role's ceiling is sized for a short
// reply, so reasoning-capable chat models exhaust it and end the stream
// `incomplete` before emitting a call. Give these probes reasoning headroom,
// but stay under the smallest output ceiling of any offered model (Amazon Nova
// v1: 5,120), because the weekly rotation runs the same probe on every model
// and providers reject a ceiling above the model's limit before the call.
export const TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS = 4096;

export const isCanaryProvider = (value: string): value is CanaryProvider =>
  CANARY_PROVIDERS.some((provider) => provider === value);

type MissingCanaryProvidersOptions = {
  configuredProviders: readonly string[];
  selection: CanaryProviderSelection;
};

export const missingCanaryProviders = ({
  configuredProviders,
  selection,
}: MissingCanaryProvidersOptions): CanaryProvider[] => {
  const configured = new Set(configuredProviders);
  const required = selection === "all" ? CANARY_PROVIDERS : [selection];
  return required.filter((provider) => !configured.has(provider));
};
