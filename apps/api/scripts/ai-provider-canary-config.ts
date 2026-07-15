import type { ModelRole } from "@stll/ai-catalog";

import type { TanStackTextProvider } from "@/api/lib/tanstack-ai-models";

export const CANARY_PROVIDERS = [
  "google",
  "openrouter",
  "openai",
  "anthropic",
  "bedrock",
  "mistral",
] as const satisfies readonly TanStackTextProvider[];

export type CanaryProvider = (typeof CANARY_PROVIDERS)[number];
export type CanaryProviderSelection = "all" | CanaryProvider;

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
