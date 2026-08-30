import { classifyAIError } from "@/api/lib/ai-error";
import { DeepLTimeoutError, DeepLUpstreamError } from "@/api/lib/deepl/errors";
import type { DocumentTranslationRunErrorCode } from "@/api/lib/document-translation/contract";

const isDeepLProviderUnavailable = (error: unknown): boolean =>
  DeepLTimeoutError.is(error) ||
  (DeepLUpstreamError.is(error) &&
    error.httpStatus !== undefined &&
    error.httpStatus >= 500);

/**
 * Reduces an untrusted provider failure to the bounded, durable run contract.
 * Provider response bodies can contain document-derived content, so they never
 * cross this boundary.
 */
export const documentTranslationProviderErrorCode = (
  error: unknown,
): DocumentTranslationRunErrorCode => {
  if (isDeepLProviderUnavailable(error)) {
    return "provider_unavailable";
  }

  const kind = classifyAIError(error);
  switch (kind) {
    case "provider_unavailable":
      return "provider_unavailable";
    case "empty_completion":
    case "loop_detected":
    case "model_unavailable":
    case "provider_billing":
    case "provider_credentials_rejected":
    case "quota_exhausted":
    case "unknown":
      return "translation_failed";
    default: {
      const exhaustiveKind: never = kind;
      return exhaustiveKind;
    }
  }
};
