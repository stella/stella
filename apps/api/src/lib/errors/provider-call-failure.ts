import { classifyAIError, providerStatusCode } from "@/api/lib/ai-error";
import {
  ProviderCallError,
  PROVIDER_CALL_ERROR_MESSAGE,
  providerCallErrorCode,
} from "@/api/lib/errors/provider-call-error";
import { createProviderDiagnostic } from "@/api/lib/errors/redacted-provider-diagnostic";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { HandlerErrorStatusCode } from "@/api/lib/errors/tagged-errors";
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

const providerFactsFrom = (evidence: unknown) => {
  const seen = new Set<object>();
  let current = evidence;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    const status = providerStatusCode(current);
    if (status !== null) {
      const isRetryable = current["isRetryable"];
      return {
        status,
        ...(typeof isRetryable === "boolean" ? { isRetryable } : {}),
      };
    }
    current = current["cause"];
  }
  return undefined;
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
    code,
    cause: evidence,
  });
  return new ProviderCallError({
    model,
    status,
    providerDiagnostic: createProviderDiagnostic({ model, evidence }),
    code: providerCallErrorCode(code),
    kind: classifyAIError(input),
    facts: providerFactsFrom(input),
    requestId: providerRequestIdFrom(evidence),
  });
};
