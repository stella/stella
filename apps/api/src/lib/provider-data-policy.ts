import type {
  OpenRouterConfig,
  OpenRouterTextModelOptions,
} from "@tanstack/ai-openrouter";

import type { AIProvider } from "@stll/ai-catalog";

import type { DecisionModelProvider } from "@/api/lib/ai-config";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ManagedProvider = AIProvider | DecisionModelProvider | "agent_sandbox";

type ProviderDataPolicy =
  | { status: "unsupported" }
  | {
      status: "supported";
      serverURL: NonNullable<OpenRouterConfig["serverURL"]>;
      provider: NonNullable<OpenRouterTextModelOptions["provider"]>;
    };

export const PROVIDER_DATA_POLICY = {
  byok: { status: "unchanged" },
  instance: {
    google: { status: "unsupported" },
    openrouter: {
      status: "supported",
      serverURL: "https://eu.openrouter.ai/api/v1",
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
  instance: Record<ManagedProvider, ProviderDataPolicy>;
};

export const MANAGED_PROVIDER_UNAVAILABLE_CODE = "managed-provider-unavailable";

export const managedProviderUnavailable = (
  provider: string,
): HandlerError<503> =>
  new HandlerError({
    status: 503,
    code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
    message: `Managed AI is not available for provider "${provider}" with the configured request policy. Configure an organization AI key or contact your administrator.`,
  });

export const isManagedProviderAvailable = (
  provider: ManagedProvider,
): boolean => PROVIDER_DATA_POLICY.instance[provider].status === "supported";

export const assertManagedProviderAvailable = (
  provider: ManagedProvider,
): void => {
  if (isManagedProviderAvailable(provider)) {
    return;
  }
  throw managedProviderUnavailable(provider);
};
