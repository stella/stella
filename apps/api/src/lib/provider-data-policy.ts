import type {
  OpenRouterConfig,
  OpenRouterTextModelOptions,
} from "@tanstack/ai-openrouter";
import { Result } from "better-result";

import type { AIProvider } from "@stll/ai-catalog";
import { classifyFailure } from "@stll/errors";

import type { DecisionModelProvider } from "@/api/lib/ai-config";
import type { AIDataClass, ManagedAIResidency } from "@/api/lib/ai-data-policy";
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

export const PROVIDER_DATA_POLICY = {
  byok: { status: "unchanged" },
  public_corpus: { status: "unchanged" },
  customer: {
    google: { status: "unsupported" },
    openrouter: {
      status: "supported",
      serverURLs: {
        eu: "https://eu.openrouter.ai/api/v1",
        us: "https://us.openrouter.ai/api/v1",
      },
      provider: { dataCollection: "deny", zdr: true },
    },
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
  public_corpus: { status: "unchanged" };
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
