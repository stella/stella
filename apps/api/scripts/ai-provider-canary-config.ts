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

  const modelRoles = MODEL_ROLES.filter(
    (role) =>
      DEFAULT_MODELS[provider][role] !== modelId &&
      isBYOKModelRoleSupported({ modelId, provider, role }),
  );
  if (modelRoles.length === 0) {
    throw new TypeError(
      `Weekly canary model ${modelId} has no non-default supported role.`,
    );
  }

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
