import type { AIErrorKind } from "@stll/api-contract";

import {
  classifyAIError,
  providerFailureFacts,
  providerStatusCode,
} from "@/api/lib/ai-error";
import {
  PROVIDER_CALL_ERROR_MESSAGE,
  ProviderCallError,
  providerCallErrorCode,
} from "@/api/lib/errors/provider-call-error";
import { providerRetryDelayMs } from "@/api/lib/errors/provider-retry-delay";
import { createProviderDiagnostic } from "@/api/lib/errors/redacted-provider-diagnostic";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";
import { NETWORK_ERROR_CODE_REASON } from "@/api/lib/observability/failure";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import { isRecord } from "@/api/lib/type-guards";

export const providerRequestIdFrom = (
  evidence: unknown,
): string | undefined => {
  const seen = new Set<object>();
  let current = evidence;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    for (const key of ["request_id", "requestId", "requestID"]) {
      const value = current[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    const response = current["rawResponse"];
    const headers =
      response instanceof Response ? response.headers : current["headers"];
    if (headers instanceof Headers) {
      const value = headers.get("x-request-id") ?? headers.get("request-id");
      if (value) {
        return value;
      }
    }
    if (isRecord(headers)) {
      const value = headers["x-request-id"] ?? headers["request-id"];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    current = current["cause"] ?? current["error"];
  }
  return undefined;
};

/**
 * The classes the provider SDKs raise for a request that got no response:
 * Stainless (OpenAI, Anthropic) and Speakeasy (Mistral, OpenRouter)
 * connection failures and timeouts. A streamed run keeps the class name in
 * its `RUN_ERROR` evidence (`patches/@tanstack%2Fai@0.65.1.patch`).
 */
const PROVIDER_TRANSPORT_FAILURE_NAMES: ReadonlySet<string> = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "ConnectionError",
  "RequestTimeoutError",
]);

/** Socket codes of a request that got no response, Bun's refusal included. */
const PROVIDER_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(NETWORK_ERROR_CODE_REASON),
  "ConnectionRefused",
]);

/** How deep a wrapped failure is searched for its transport class. */
const TRANSPORT_CAUSE_DEPTH = 6;

/**
 * Marks evidence a provider adapter itself raised or reported. The model
 * factory sets it on every failure its adapters produce
 * (`withProviderFailureOrigin`); a failure from anything else a run does
 * (an MCP connection, a middleware's database or cache call) never carries
 * it.
 */
const PROVIDER_ADAPTER_FAILURE = Symbol("provider adapter failure");

/** `error`, marked as one the provider adapter raised. */
export const markProviderAdapterError = <TError>(error: TError): TError => {
  if (
    typeof error === "object" &&
    error !== null &&
    Object.isExtensible(error)
  ) {
    Object.defineProperty(error, PROVIDER_ADAPTER_FAILURE, {
      enumerable: true,
      value: true,
    });
  }
  return error;
};

/** A copy of a run error's evidence, marked as the provider adapter's. */
export const providerAdapterEvidence = (
  evidence: Record<string, unknown>,
): Record<string | symbol, unknown> => ({
  ...evidence,
  [PROVIDER_ADAPTER_FAILURE]: true,
});

/**
 * A request the provider adapter sent that got no response: a transport
 * class or socket code in the chain, under a link the adapter marked.
 */
const transportEvidenceOf = (
  evidence: unknown,
): { fromAdapter: boolean; transport: boolean } => {
  let fromAdapter = false;
  let transport = false;
  let current: unknown = evidence;
  for (
    let depth = 0;
    depth < TRANSPORT_CAUSE_DEPTH && isRecord(current);
    depth += 1
  ) {
    fromAdapter ||= Reflect.get(current, PROVIDER_ADAPTER_FAILURE) === true;
    const { name, code } = current;
    transport ||=
      (typeof name === "string" &&
        PROVIDER_TRANSPORT_FAILURE_NAMES.has(name)) ||
      (typeof code === "string" && PROVIDER_TRANSPORT_CODES.has(code));
    current = current["cause"];
  }
  return { fromAdapter, transport };
};

/**
 * The kind of a failed provider request. A request the provider adapter sent
 * that got no response (refused, reset, timed out) is an unavailable
 * provider here: this boundary knows that destination is the provider's own
 * endpoint, which a general network classification cannot assume. The same
 * failure from anything else a run does stays unknown.
 */
export const providerFailureKind = (evidence: unknown): AIErrorKind => {
  const kind = classifyAIError(evidence);
  if (kind !== "unknown" && kind !== "provider_unavailable") {
    return kind;
  }
  if (providerStatusCode(evidence) !== null) {
    // The provider answered: its status names the failure.
    return kind;
  }
  const { fromAdapter, transport } = transportEvidenceOf(evidence);
  if (!fromAdapter) {
    // A socket failure from anything but the provider adapter is not the
    // provider's, whatever its code.
    return "unknown";
  }
  return transport ? "provider_unavailable" : kind;
};

type CreateProviderCallErrorOptions = {
  model: Pick<ResolvedTanStackTextModel, "provider" | "keySource">;
  evidence: unknown;
  status: HandlerErrorStatusCode;
  code?: string | undefined;
};

// Provider evidence is consumed here; the error retains its structural
// projection. The raw `code` informs classification only.
export const createProviderCallError = ({
  model,
  evidence,
  status,
  code,
}: CreateProviderCallErrorOptions) => {
  const input = new HandlerError({
    message: PROVIDER_CALL_ERROR_MESSAGE,
    status,
    code: code ?? "internal_error",
    cause: evidence,
  });
  return new ProviderCallError({
    model,
    status,
    providerDiagnostic: createProviderDiagnostic({ model, evidence }),
    code: providerCallErrorCode(code) ?? "provider_error",
    kind: providerFailureKind(input),
    facts: providerFailureFacts(input),
    requestId: providerRequestIdFrom(evidence),
    retryAfterMs: providerRetryDelayMs(evidence),
  });
};
