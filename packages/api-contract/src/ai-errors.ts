export const AI_ERROR_KINDS = [
  "quota_exhausted",
  "provider_billing",
  "model_unavailable",
  "provider_unavailable",
  "loop_detected",
  "empty_completion",
  "unknown",
] as const;

export type AIErrorKind = (typeof AI_ERROR_KINDS)[number];
