import { classifyAIError } from "@/api/lib/ai-error";
import type { DocumentTranslationRunErrorCode } from "@/api/lib/document-translation/contract";

/**
 * Reduces an untrusted provider failure to the bounded, durable run contract.
 * Provider response bodies can contain document-derived content, so they never
 * cross this boundary.
 */
export const documentTranslationProviderErrorCode = (
  error: unknown,
): DocumentTranslationRunErrorCode => {
  const kind = classifyAIError(error);
  switch (kind) {
    case "provider_unavailable":
      return "provider_unavailable";
    case "empty_completion":
    case "loop_detected":
    case "model_unavailable":
    case "provider_billing":
    case "quota_exhausted":
    case "unknown":
      return "translation_failed";
    default: {
      const exhaustiveKind: never = kind;
      return exhaustiveKind;
    }
  }
};
