/**
 * Lightweight provider key health-check. Calls the provider's
 * own auth/list-models endpoint (no token cost). Used pre-save
 * in BYOK flows so the user gets a green/red signal before
 * committing the config.
 */

import { Result } from "better-result";

import { env } from "@/api/env";
import {
  AZURE_FOUNDRY_DEFAULT_API_VERSION,
  normalizeAzureFoundryBaseURL,
} from "@/api/lib/azure-foundry";
import type { SafeOutboundFetchResponse } from "@/api/lib/safe-outbound-fetch";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";

const DEFAULT_VALIDATION_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 1_000_000;

export const PROVIDER_PROBE_VALUES = [
  "google",
  "openrouter",
  "openai",
  "azure_foundry",
  "anthropic",
  "mistral",
  "huggingface",
] as const;

export type ProviderProbeValue = (typeof PROVIDER_PROBE_VALUES)[number];

export type ProviderProbeResult =
  | { valid: true }
  | { valid: false; error: string };

type ProbeTarget = {
  url: URL;
  headers?: Record<string, string>;
};

const PROBE_TARGETS: Record<
  Exclude<ProviderProbeValue, "azure_foundry" | "huggingface">,
  (apiKey: string) => ProbeTarget
> = {
  google: (apiKey) => ({
    url: new URL(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    ),
  }),
  anthropic: (apiKey) => ({
    url: new URL("https://api.anthropic.com/v1/models"),
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  }),
  openai: (apiKey) => ({
    url: new URL("https://api.openai.com/v1/models"),
    headers: { Authorization: `Bearer ${apiKey}` },
  }),
  openrouter: (apiKey) => ({
    url: new URL("https://openrouter.ai/api/v1/auth/key"),
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
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const extractDetail = (
  response: SafeOutboundFetchResponse,
): string | undefined => {
  const body = parseJsonBody(response);
  if (!body) {
    return undefined;
  }
  const errorField = body["error"];
  if (typeof errorField === "string") {
    return errorField;
  }
  if (isRecord(errorField) && typeof errorField["message"] === "string") {
    return errorField["message"];
  }
  if (typeof body["message"] === "string") {
    return body["message"];
  }
  return undefined;
};

export const probeProvider = async (
  provider: ProviderProbeValue,
  apiKey: string,
  endpoint?: string,
  apiVersion?: string,
  expectedAzureDeployments?: readonly string[],
  timeoutMs: number = DEFAULT_VALIDATION_TIMEOUT_MS,
): Promise<ProviderProbeResult> => {
  if (provider === "azure_foundry") {
    return await probeAzureFoundry(
      apiKey,
      endpoint,
      apiVersion,
      expectedAzureDeployments,
      timeoutMs,
    );
  }

  if (provider === "huggingface") {
    return await probeHuggingFace(apiKey, endpoint, timeoutMs);
  }

  const target = PROBE_TARGETS[provider](apiKey);
  const response = await safeOutboundFetchBytes({
    url: target.url,
    headers: target.headers,
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

  const detail = extractDetail(response.value);
  const label = PROVIDER_LABELS[provider];
  return {
    valid: false,
    error: detail
      ? `${label} rejected the key (HTTP ${response.value.status}): ${detail}`
      : `${label} rejected the key (HTTP ${response.value.status})`,
  };
};

const probeHuggingFace = async (
  apiKey: string,
  endpoint: string | undefined,
  timeoutMs: number,
): Promise<ProviderProbeResult> => {
  const trimmed = endpoint?.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: "Hugging Face endpoint is required",
    };
  }

  let url: URL;
  try {
    url = new URL(`${trimmed.replace(/\/$/u, "")}/models`);
  } catch {
    return {
      valid: false,
      error: "Hugging Face endpoint must be a valid URL",
    };
  }

  const response = await safeOutboundFetchBytes({
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

  const detail = extractDetail(response.value);
  return {
    valid: false,
    error: detail
      ? `Hugging Face rejected the key or endpoint (HTTP ${response.value.status}): ${detail}`
      : `Hugging Face rejected the key or endpoint (HTTP ${response.value.status})`,
  };
};

const probeAzureFoundry = async (
  apiKey: string,
  endpoint: string | undefined,
  apiVersion: string | undefined,
  expectedDeployments: readonly string[] | undefined,
  timeoutMs: number,
): Promise<ProviderProbeResult> => {
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
  const response = await safeOutboundFetchBytes({
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
    const detail = extractDetail(response.value);
    return {
      valid: false,
      error: detail
        ? `Azure Foundry rejected the key or endpoint (HTTP ${response.value.status}): ${detail}`
        : `Azure Foundry rejected the key or endpoint (HTTP ${response.value.status})`,
    };
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
