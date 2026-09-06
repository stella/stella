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

// The optional string fields in canary tool schemas must accept no real
// string, so that "omit or send the synthetic null" is the only valid choice
// for the model. An unsatisfiable regex (`a^`) expressed that until OpenAI's
// strict-mode grammar compiler started dead-ending on it: the request ends
// `incomplete` with zero output tokens before any tool call. `maxLength: 0`
// says the same thing in a form every constrained decoder handles. It still
// admits the empty string, which non-strict models do emit for a field the
// prompt told them to omit; the round-trip probe accepts that as a model
// choice and fails only on the synthetic null the adapter must strip.
export const IMPOSSIBLE_STRING_MAX_LENGTH = 0;

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

// Providers reject a request whose ceiling exceeds the model's output limit
// before generating anything (Bedrock: "The maximum tokens you requested
// exceeds the model limit of 10000"). The weekly rotation runs every role
// probe on every offered Bedrock model, so the map is total over that
// catalog: adding a model forces a decision here, `null` meaning its limit
// is above every role budget and the budget is sent as is.
type BedrockModelId = (typeof BYOK_MODEL_OPTIONS)["bedrock"][number];
const MODEL_MAX_OUTPUT_TOKENS = {
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": null,
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": null,
  "us.amazon.nova-pro-v1:0": 10_000,
  "us.amazon.nova-lite-v1:0": 10_000,
  "us.amazon.nova-micro-v1:0": 10_000,
  "openai.gpt-oss-120b-1:0": null,
  "openai.gpt-oss-20b-1:0": null,
  "us.deepseek.r1-v1:0": null,
} as const satisfies Record<BedrockModelId, number | null>;

const isBedrockModelId = (modelId: string): modelId is BedrockModelId =>
  Object.hasOwn(MODEL_MAX_OUTPUT_TOKENS, modelId);

const clampToModelOutputLimit = (modelId: string, budget: number) => {
  if (!isBedrockModelId(modelId)) {
    return budget;
  }
  const limit = MODEL_MAX_OUTPUT_TOKENS[modelId];
  return limit === null ? budget : Math.min(budget, limit);
};

type RoleBudgetOptions = {
  modelId: string;
  role: ModelRole;
};

export const modelRoleMaxOutputTokens = ({
  modelId,
  role,
}: RoleBudgetOptions) =>
  clampToModelOutputLimit(modelId, MODEL_ROLE_MAX_OUTPUT_TOKENS[role]);

// Anthropic's SDK rejects non-streaming structured-output requests whose
// ceiling can exceed its ten-minute window. Keep the reasoning probe below
// the adapter's documented ~21K clamp while leaving streaming probes intact.
export const structuredOutputModelRoleMaxOutputTokens = ({
  modelId,
  role,
}: RoleBudgetOptions) =>
  clampToModelOutputLimit(
    modelId,
    role === "reasoning" ? 20_000 : MODEL_ROLE_MAX_OUTPUT_TOKENS[role],
  );

// Tool-execution probes may spend thinking tokens before the call, so they
// get more headroom than a short-reply role, while staying under every
// per-model output limit above because the weekly rotation runs the same
// probe on every model.
export const TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS = 4096;

// The structured-output-budget-edge probe answers every property in its
// schema (`null` answer, empty justification), so its output grows with the
// property count `buildBudgetEdgeSchema` found — up to ~75 properties for a
// 100 000-byte documented budget. The fixed "fast"-role ceiling above (512
// tokens, sized for a one-line canary reply) truncates that response well
// before it finishes; this scales headroom with the schema actually sent.
const BUDGET_EDGE_PROBE_OUTPUT_TOKENS_BASE = 256;
const BUDGET_EDGE_PROBE_OUTPUT_TOKENS_PER_PROPERTY = 50;

// The per-property estimate above prices the answer the prompt asks for. The
// probe runs at the "fast" role, whose default is a provider's smallest
// model, and a small model fills the fields it was told to leave empty; the
// object then stops at the ceiling, and a truncated structured object is not
// a short answer but a failed one. Bedrock rejects the cut-off tool use
// outright ("Model produced invalid sequence as part of ToolUse"), Google
// reports `max_tokens`, and either reads as provider drift the provider did
// not cause. Floor the ceiling at the same value the tool-execution probes
// already use, so only a schema past ~77 properties needs the scale above.
export const structuredOutputBudgetEdgeMaxOutputTokens = ({
  modelId,
  propertyCount,
}: {
  modelId: string;
  propertyCount: number;
}) =>
  clampToModelOutputLimit(
    modelId,
    Math.max(
      TOOL_CALL_PROBE_MAX_OUTPUT_TOKENS,
      BUDGET_EDGE_PROBE_OUTPUT_TOKENS_BASE +
        propertyCount * BUDGET_EDGE_PROBE_OUTPUT_TOKENS_PER_PROPERTY,
    ),
  );

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
