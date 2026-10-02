import type {
  OpenRouterConfig,
  OpenRouterTextModelOptions,
} from "@tanstack/ai-openrouter";
import { Result } from "better-result";

import { BYOK_MODEL_OPTIONS, getModelRate } from "@stll/ai-catalog";
import type { AIProvider } from "@stll/ai-catalog";
import { classifyFailure } from "@stll/errors";

import type { DecisionModelProvider } from "@/api/lib/ai-config";
import type {
  AIDataClass,
  ManagedAIResidency,
} from "@/api/lib/chat/ai-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ManagedProvider = AIProvider | DecisionModelProvider | "agent_sandbox";

type ProviderDataPolicy =
  | { status: "unsupported" }
  | {
      status: "supported";
      serverURLs: Record<
        ManagedAIResidency,
        NonNullable<OpenRouterConfig["serverURL"]>
      >;
      provider: NonNullable<OpenRouterTextModelOptions["provider"]>;
    };

const MANAGED_OPENROUTER_POLICY = {
  status: "supported",
  serverURLs: {
    eu: "https://eu.openrouter.ai/api/v1",
    us: "https://us.openrouter.ai/api/v1",
  },
  provider: { dataCollection: "deny", zdr: true },
} as const satisfies ProviderDataPolicy;

export const PROVIDER_DATA_POLICY = {
  byok: { status: "unchanged" },
  public_corpus: {
    ...MANAGED_OPENROUTER_POLICY,
    managedAIResidency: "eu",
  },
  customer: {
    google: { status: "unsupported" },
    openrouter: MANAGED_OPENROUTER_POLICY,
    openai: { status: "unsupported" },
    azure_foundry: { status: "unsupported" },
    anthropic: { status: "unsupported" },
    bedrock: { status: "unsupported" },
    mistral: { status: "unsupported" },
    openai_compatible: { status: "unsupported" },
    huggingface: { status: "unsupported" },
    typesafe: { status: "unsupported" },
    agent_sandbox: { status: "unsupported" },
  },
} as const satisfies {
  byok: { status: "unchanged" };
  public_corpus: Extract<ProviderDataPolicy, { status: "supported" }> & {
    managedAIResidency: "eu";
  };
  customer: Record<ManagedProvider, ProviderDataPolicy>;
};

export const MANAGED_PROVIDER_UNAVAILABLE_CODE = "managed-provider-unavailable";

export const managedProviderUnavailable = (
  provider: string,
): HandlerError<503> =>
  classifyFailure(
    new HandlerError({
      status: 503,
      code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
      message: `Managed AI is not available for provider "${provider}" with the configured request policy. Configure an organization AI key or contact your administrator.`,
    }),
    "model_unavailable",
  );

export const isManagedProviderAvailable = (
  provider: ManagedProvider,
  dataClass: AIDataClass,
): boolean =>
  dataClass === "public_corpus" ||
  PROVIDER_DATA_POLICY.customer[provider].status === "supported";

export const checkManagedProviderAvailable = (
  provider: ManagedProvider,
  dataClass: AIDataClass,
): Result<void, HandlerError<503>> =>
  isManagedProviderAvailable(provider, dataClass)
    ? Result.ok(undefined)
    : Result.err(managedProviderUnavailable(provider));

const OPENROUTER_AUTO_MODEL_ID = "openrouter/auto";
const GLOBAL_ONLY_OPENROUTER_VARIANT = /:(?:batch|online)(?=:|$)/u;

/** Validate every managed selection, including fallback models on the wire. */
export const assertManagedOpenRouterModel = (modelId: string): void => {
  const catalog: readonly string[] = BYOK_MODEL_OPTIONS.openrouter;
  if (
    modelId === OPENROUTER_AUTO_MODEL_ID ||
    GLOBAL_ONLY_OPENROUTER_VARIANT.test(modelId) ||
    !catalog.includes(modelId) ||
    getModelRate(modelId) === undefined
  ) {
    throw managedProviderUnavailable("openrouter");
  }
};
