/**
 * Lightweight provider key health-check. Calls the provider's
 * own auth/list-models endpoint (no token cost). Used pre-save
 * in BYOK flows so the user gets a green/red signal before
 * committing the config.
 */

import { Result } from "better-result";

import type { ProviderSetupErrorCode } from "@stll/api-contract/provider-setup";

import { env } from "@/api/env";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  AZURE_FOUNDRY_DEFAULT_API_VERSION,
  normalizeAzureFoundryBaseURL,
} from "@/api/lib/azure-foundry";
import { anthropicWorkspaceHeaders } from "@/api/lib/chat/anthropic-config";
import { PROVIDER_DATA_POLICY } from "@/api/lib/chat/provider-data-policy";
import { identifyProviderSetupError } from "@/api/lib/errors/provider-error-catalogue";
import { normalizeHuggingFaceBaseURL } from "@/api/lib/huggingface";
import { sanitizeCredentialText } from "@/api/lib/observability/credential-text";
import type {
  SafeOutboundFetchResponse,
  SafeOutboundFetchBody,
  SafeOutboundHeaders,
} from "@/api/lib/safe-outbound-fetch";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";

const DEFAULT_VALIDATION_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 1_000_000;
const PROBE_ERROR_MAX_BYTES = 64 * 1024;
type ProbeFetch = (opts: {
  body?: SafeOutboundFetchBody;
  headers?: SafeOutboundHeaders;
  maxBytes: number;
  method?: string;
  permit: ThirdPartyOutboundPermit;
  timeoutMs: number;
  url: string | URL;
}) => ReturnType<typeof safeOutboundFetchBytes>;

export const PROVIDER_PROBE_VALUES = [
  "google",
  "openrouter",
  "openai",
  "azure_foundry",
  "anthropic",
  "bedrock",
  "mistral",
  "huggingface",
] as const;

export type ProviderProbeValue = (typeof PROVIDER_PROBE_VALUES)[number];

export type ProviderProbeResult =
  | { valid: true }
  | { valid: false; error: string; code?: ProviderSetupErrorCode };

type ProbeTarget = {
  url: URL;
  headers?: Record<string, string>;
};

const PROBE_TARGETS: Record<
  Exclude<ProviderProbeValue, "azure_foundry" | "huggingface">,
  (apiKey: string) => ProbeTarget
> = {
  google: (apiKey) => ({
    url: new URL("https://generativelanguage.googleapis.com/v1beta/models"),
    headers: { "x-goog-api-key": apiKey },
  }),
  anthropic: (apiKey) => ({
    url: new URL("https://api.anthropic.com/v1/models"),
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  }),
  bedrock: (apiKey) => ({
    url: new URL("https://bedrock.us-east-1.amazonaws.com/foundation-models"),
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
  openai: (apiKey) => ({
    url: new URL("https://api.openai.com/v1/models"),
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
  openrouter: (apiKey) => ({
    url: new URL(
      `${PROVIDER_DATA_POLICY.public_corpus.serverURLs.eu}/auth/key`,
    ),
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
  mistral: (apiKey) => ({
    url: new URL("https://api.mistral.ai/v1/models"),
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
};

const PROVIDER_LABELS: Record<ProviderProbeValue, string> = {
  google: "Google",
  anthropic: "Anthropic",
  bedrock: "Bedrock",
  openai: "OpenAI",
  azure_foundry: "Azure Foundry",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  huggingface: "Hugging Face",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseJsonBody = (
  response: SafeOutboundFetchResponse,
): Record<string, unknown> | undefined => {
  const result = Result.try((): unknown =>
    JSON.parse(new TextDecoder().decode(response.body)),
  );
  return result.isOk() && isRecord(result.value) ? result.value : undefined;
};

const extractDetail = (
  response: SafeOutboundFetchResponse,
  apiKey: string,
): string | undefined => {
  const body = parseJsonBody(response);
  if (!body) {
    return undefined;
  }
  const errorField = body["error"];
  if (typeof errorField === "string") {
    return sanitizeCredentialText(errorField, [apiKey]).text;
  }
  if (isRecord(errorField) && typeof errorField["message"] === "string") {
    return sanitizeCredentialText(errorField["message"], [apiKey]).text;
  }
  if (typeof body["message"] === "string") {
    return sanitizeCredentialText(body["message"], [apiKey]).text;
  }
  return undefined;
};

type ProviderProbeFailureOptions = {
  apiKey: string;
  provider: ProviderProbeValue;
  response: SafeOutboundFetchResponse;
};

const providerProbeFailure = ({
  apiKey,
  provider,
  response,
}: ProviderProbeFailureOptions): ProviderProbeResult => {
  const label = PROVIDER_LABELS[provider];
  const detail = extractDetail(response, apiKey);
  if (
    detail !== undefined &&
    new TextEncoder().encode(detail).byteLength > PROBE_ERROR_MAX_BYTES
  ) {
    return {
      valid: false,
      error: `${label} returned an error message exceeding the 64 KiB diagnostic limit (HTTP ${response.status}); verification could not display the full provider error`,
    };
  }

  const error = parseJsonBody(response)?.["error"];
  const code = identifyProviderSetupError({
    provider,
    error: isRecord(error) ? error : undefined,
  });
  const rejected =
    provider === "azure_foundry" || provider === "huggingface"
      ? "key or endpoint"
      : "key";
  const summary = `${label} rejected the ${rejected} (HTTP ${response.status})`;
  return {
    valid: false,
    ...(code === undefined ? {} : { code }),
    error: detail ? `${summary}: ${detail}` : summary,
  };
};

/**
 * Where a provider without a fixed endpoint is served, which Azure
 * deployments it must expose, and how the probe reaches it.
 */
export type ProbeProviderOptions = {
  apiKey: string;
  permit: ThirdPartyOutboundPermit;
  provider: ProviderProbeValue;
  anthropicWorkspaceId?: string | undefined;
  endpoint?: string;
  apiVersion?: string;
  expectedAzureDeployments?: readonly string[];
  timeoutMs?: number;
  fetchBytes?: ProbeFetch;
};

export const probeProvider = async ({
  apiKey,
  provider,
  permit,
  endpoint,
  anthropicWorkspaceId,
  apiVersion,
  expectedAzureDeployments,
  timeoutMs = DEFAULT_VALIDATION_TIMEOUT_MS,
  fetchBytes = safeOutboundFetchBytes,
}: ProbeProviderOptions): Promise<ProviderProbeResult> => {
  if (provider === "azure_foundry") {
    return await probeAzureFoundry({
      apiKey,
      endpoint,
      apiVersion,
      expectedDeployments: expectedAzureDeployments,
      timeoutMs,
      fetchBytes,
      permit,
    });
  }

  if (provider === "huggingface") {
    return await probeHuggingFace({
      apiKey,
      endpoint,
      fetchBytes,
      permit,
      timeoutMs,
    });
  }

  const target = PROBE_TARGETS[provider](apiKey);
  if (provider === "anthropic") {
    target.headers = {
      ...target.headers,
      ...anthropicWorkspaceHeaders(anthropicWorkspaceId),
    };
  }
  const response = await fetchBytes({
    permit,
    url: target.url,
    ...(target.headers === undefined ? {} : { headers: target.headers }),
    maxBytes: PROBE_MAX_BYTES,
    method: "GET",
    timeoutMs,
  });

  if (Result.isError(response)) {
    throw response.error;
  }

  if (response.value.ok) {
    return { valid: true };
  }

  return providerProbeFailure({ apiKey, provider, response: response.value });
};

const probeHuggingFace = async ({
  apiKey,
  endpoint,
  fetchBytes,
  permit,
  timeoutMs,
}: {
  apiKey: string;
  endpoint: string | undefined;
  fetchBytes: ProbeFetch;
  permit: ThirdPartyOutboundPermit;
  timeoutMs: number;
}): Promise<ProviderProbeResult> => {
  const trimmed = endpoint?.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: "Hugging Face endpoint is required",
    };
  }

  const normalized = normalizeHuggingFaceBaseURL(trimmed);
  if (!normalized.ok) {
    return { valid: false, error: normalized.error };
  }
  const url = new URL(`${normalized.baseURL}/models`);

  const response = await fetchBytes({
    permit,
    url,
    headers: { Authorization: `Bearer ${apiKey}` },
    maxBytes: PROBE_MAX_BYTES,
    method: "GET",
    timeoutMs,
  });

  if (Result.isError(response)) {
    throw response.error;
  }

  if (response.value.ok) {
    return { valid: true };
  }

  return providerProbeFailure({
    apiKey,
    provider: "huggingface",
    response: response.value,
  });
};

const probeAzureFoundry = async ({
  apiKey,
  endpoint,
  apiVersion,
  expectedDeployments,
  timeoutMs,
  fetchBytes,
  permit,
}: {
  apiKey: string;
  endpoint: string | undefined;
  apiVersion: string | undefined;
  expectedDeployments: readonly string[] | undefined;
  timeoutMs: number;
  fetchBytes: ProbeFetch;
  permit: ThirdPartyOutboundPermit;
}): Promise<ProviderProbeResult> => {
  if (!endpoint?.trim()) {
    return {
      valid: false,
      error: "Azure Foundry endpoint is required",
    };
  }

  const normalized = normalizeAzureFoundryBaseURL(endpoint);
  if (!normalized.ok) {
    return { valid: false, error: normalized.error };
  }

  const url = new URL(`${normalized.baseURL}/v1/models`);
  url.searchParams.set("api-version", resolveAzureApiVersion(apiVersion));
  const response = await fetchBytes({
    permit,
    url,
    headers: { "api-key": apiKey },
    maxBytes: PROBE_MAX_BYTES,
    method: "GET",
    timeoutMs,
  });

  if (Result.isError(response)) {
    throw response.error;
  }

  if (!response.value.ok) {
    return providerProbeFailure({
      apiKey,
      provider: "azure_foundry",
      response: response.value,
    });
  }

  if (!expectedDeployments || expectedDeployments.length === 0) {
    return { valid: true };
  }

  const deployments = extractAzureDeployments(response.value);
  const missing = expectedDeployments.filter(
    (deployment) => !deployments.has(deployment),
  );
  if (missing.length > 0) {
    return {
      valid: false,
      error: `Azure Foundry deployment not found: ${missing.join(", ")}`,
    };
  }
  return { valid: true };
};

const extractAzureDeployments = (
  response: SafeOutboundFetchResponse,
): ReadonlySet<string> => {
  const body = parseJsonBody(response);
  if (!body || !Array.isArray(body["data"])) {
    return new Set<string>();
  }
  const ids = body["data"].flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
  );
  return new Set<string>(ids);
};

const resolveAzureApiVersion = (apiVersion: string | undefined): string =>
  apiVersion?.trim() ||
  env.AZURE_API_VERSION ||
  AZURE_FOUNDRY_DEFAULT_API_VERSION;
