import type {
  OpenRouterConfig,
  OpenRouterTextModelOptions,
} from "@tanstack/ai-openrouter";
import { Result, panic } from "better-result";

import type { AIProvider } from "@stll/ai-catalog";
import { classifyFailure } from "@stll/errors";
import { fetchWithTimeout, type FetchWithTimeoutInit } from "@stll/fetch";

import type { DecisionModelProvider } from "@/api/lib/ai-config";
import type {
  AIDataClass,
  ManagedAIResidency,
} from "@/api/lib/chat/ai-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

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

const MANAGED_EU_ORIGIN = "https://eu.openrouter.ai";
const MANAGED_US_ORIGIN = "https://us.openrouter.ai";
const MANAGED_PUBLIC_ORIGIN = "https://openrouter.ai";
const MANAGED_PROVIDER_REQUEST_TIMEOUT_MS = 16 * 60 * 1000;
const MANAGED_PROVIDER_ORIGINS = [
  MANAGED_EU_ORIGIN,
  MANAGED_US_ORIGIN,
] as const;

export const fetchManagedProviderCatalog = async (
  url: string,
  init: FetchWithTimeoutInit,
) => {
  const target = restrictOutboundUrl({
    rawUrl: url,
    hostPolicy: { type: "exact-origin", origins: MANAGED_PROVIDER_ORIGINS },
    pathPrefixes: ["/api/v1/models"],
  });
  if (target === null) {
    return panic("Managed catalog target is outside the provider policy.");
  }
  return await fetchWithTimeout(target, { ...init, redirect: "error" });
};

export const PROVIDER_DATA_POLICY = {
  byok: { status: "unchanged" },
  public_corpus: { status: "unchanged" },
  customer: {
    google: { status: "unsupported" },
    openrouter: {
      status: "supported",
      serverURLs: {
        eu: `${MANAGED_EU_ORIGIN}/api/v1`,
        us: `${MANAGED_US_ORIGIN}/api/v1`,
      } satisfies Record<
        ManagedAIResidency,
        `${(typeof MANAGED_PROVIDER_ORIGINS)[number]}/api/v1`
      >,
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
  cause?: unknown,
): HandlerError<503> =>
  classifyFailure(
    new HandlerError({
      status: 503,
      code: MANAGED_PROVIDER_UNAVAILABLE_CODE,
      cause,
      message: `Managed AI is not available for provider "${provider}" with the configured request policy. Configure an organization AI key or contact your administrator.`,
    }),
    "model_unavailable",
  );

export const fetchManagedOpenRouterCompletion = async (request: Request) => {
  const euEndpoint = `${MANAGED_EU_ORIGIN}/api/v1/chat/completions`;
  const usEndpoint = `${MANAGED_US_ORIGIN}/api/v1/chat/completions`;
  const publicEndpoint = `${MANAGED_PUBLIC_ORIGIN}/api/v1/chat/completions`;
  const regionalEndpoint = request.url === euEndpoint ? euEndpoint : usEndpoint;
  const endpoint =
    request.url === publicEndpoint ? publicEndpoint : regionalEndpoint;
  if (endpoint !== request.url) {
    return Result.err(managedProviderUnavailable("openrouter"));
  }
  // Manual mode exposes redirects without forwarding the request body.
  const fetched = await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(endpoint, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        timeoutMs: MANAGED_PROVIDER_REQUEST_TIMEOUT_MS,
        redirect: "manual",
      }),
    catch: () => managedProviderUnavailable("openrouter"),
  });
  if (Result.isError(fetched)) {
    return fetched;
  }
  const response = fetched.value;
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    await Result.tryPromise(async () => await response.body?.cancel());
    return Result.err(managedProviderUnavailable("openrouter"));
  }
  return Result.ok(response);
};

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
