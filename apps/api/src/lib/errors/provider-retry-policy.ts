import { panic } from "better-result";

import type { AIProvider } from "@stll/ai-catalog";

import { ProviderCallError } from "@/api/lib/errors/provider-call-error";
import { providerFailureKind } from "@/api/lib/errors/provider-call-failure";
import {
  PROVIDER_RETRY_WAIT_CAP_MS,
  providerRetryDelayMs,
} from "@/api/lib/errors/provider-retry-delay";
import { readProviderStatus } from "@/api/lib/observability/failure-evidence";
import { isRecord } from "@/api/lib/type-guards";

/**
 * How a failed model request is retried. The generation layer is the only
 * place that retries one: every provider client is built with its own
 * retries off (`tanstack-ai-models.ts`), and this policy restates what those
 * SDKs retried, so a request is never sent again below the layer that
 * decides each dispatch.
 *
 * The SDKs it restates, as installed:
 *
 * - OpenAI and Anthropic (Stainless): two retries; 408, 409, 429, any 5xx,
 *   connection failures and timeouts; `x-should-retry` decides first;
 *   `retry-after-ms` or `retry-after` is waited out, otherwise
 *   min(0.5 s * 2^n, 8 s) less up to 25 % jitter.
 * - Bedrock (AWS standard mode): three attempts; throttling, 500/502/503/504,
 *   transient network codes and timeouts.
 * - Google (`@google/genai`), Mistral and OpenRouter (Speakeasy) retry
 *   nothing unless configured; Stella configured OpenRouter to retry 5xx
 *   and connection failures for up to four seconds.
 *
 * The union is retried with the Stainless schedule, the one the most
 * providers followed: at most {@link PROVIDER_REQUEST_ATTEMPTS} attempts, a
 * stated delay up to {@link PROVIDER_RETRY_WAIT_CAP_MS} waited out, and a
 * longer stated delay left to the caller, which reports when to retry.
 */
export const PROVIDER_REQUEST_ATTEMPTS = 3;

const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 8000;
/** The share of a backoff delay the jitter may take off. */
const BACKOFF_JITTER = 0.25;

/** Only these SDKs retried a 409 (their lock timeout). */
const CONFLICT_RETRYING_PROVIDERS: ReadonlySet<AIProvider> = new Set([
  "anthropic",
  "openai",
]);

/**
 * The provider's own word on retrying, where it gave one: the
 * `x-should-retry` header a Stainless client obeys, carried as the
 * failure's `isRetryable` fact.
 */
const providerRetryVerdict = (error: unknown): boolean | undefined => {
  const facts = error instanceof ProviderCallError ? error.cause : error;
  if (!isRecord(facts)) {
    return undefined;
  }
  const verdict = facts["isRetryable"];
  return typeof verdict === "boolean" ? verdict : undefined;
};

const providerOf = (error: unknown): AIProvider | undefined =>
  error instanceof ProviderCallError ? error.provider : undefined;

const statusOf = (error: unknown): number | undefined =>
  error instanceof ProviderCallError
    ? error.providerStatus
    : readProviderStatus(error)?.status;

/**
 * Whether a failed request is one the provider SDKs retried: a rate limit,
 * a provider outage, a request timeout, a lock timeout where the SDK
 * retried it, or a request that got no response. An application error, a
 * refusal the provider means (billing, credentials, a retired model, a bad
 * request) and a cancellation are not.
 */
export const isTransientProviderFailure = (error: unknown): boolean => {
  const verdict = providerRetryVerdict(error);
  if (verdict !== undefined) {
    return verdict;
  }
  // A request that got no response (refused, reset, timed out) is named
  // `provider_unavailable` by `providerFailureKind`.
  const kind =
    error instanceof ProviderCallError
      ? error.kind
      : providerFailureKind(error);
  switch (kind) {
    case "quota_exhausted":
    case "provider_unavailable":
      return true;
    case "provider_billing":
    case "provider_credentials_rejected":
    case "model_unavailable":
    case "provider_stream_incomplete":
    case "output_incomplete":
    case "output_invalid":
    case "output_moderated":
    case "deadline_exceeded":
    case "loop_detected":
    case "empty_completion":
      return false;
    case "unknown": {
      const status = statusOf(error);
      if (status === 408) {
        return true;
      }
      if (status === 409) {
        const provider = providerOf(error);
        return (
          provider !== undefined && CONFLICT_RETRYING_PROVIDERS.has(provider)
        );
      }
      return false;
    }
    default:
      kind satisfies never;
      return panic(`Unhandled AI error kind: ${String(kind)}`);
  }
};

/** The SDK backoff before retry `retry` (0 for the first retry). */
export const providerBackoffMs = (retry: number, random: number): number =>
  Math.min(BACKOFF_INITIAL_MS * 2 ** retry, BACKOFF_MAX_MS) *
  (1 - random * BACKOFF_JITTER);

const statedDelayMs = (error: unknown): number | undefined =>
  error instanceof ProviderCallError
    ? error.retryAfterMs
    : providerRetryDelayMs(error);

export type ProviderRetryOptions = {
  error: unknown;
  /** How many retries this request has had already. */
  retries: number;
  /** A number in [0, 1) for the backoff jitter. */
  random: number;
};

/**
 * How long to wait before sending a failed request again, or undefined when
 * it is not sent again: the failure is not transient, the attempts are
 * spent, or the provider asked for a longer wait than a caller holds a
 * request for (the failure keeps that delay, so the caller can report it).
 */
export const providerRetryDelay = ({
  error,
  retries,
  random,
}: ProviderRetryOptions): number | undefined => {
  if (
    retries + 1 >= PROVIDER_REQUEST_ATTEMPTS ||
    !isTransientProviderFailure(error)
  ) {
    return undefined;
  }
  const stated = statedDelayMs(error);
  if (stated === undefined) {
    return providerBackoffMs(retries, random);
  }
  return stated > PROVIDER_RETRY_WAIT_CAP_MS ? undefined : stated;
};
