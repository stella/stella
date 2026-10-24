export const AI_ERROR_KINDS = [
  "quota_exhausted",
  "provider_billing",
  "provider_credentials_rejected",
  "model_unavailable",
  "provider_unavailable",
  "provider_stream_incomplete",
  "output_incomplete",
  "output_moderated",
  "output_invalid",
  "deadline_exceeded",
  "loop_detected",
  "empty_completion",
  "unknown",
] as const;

export type AIErrorKind = (typeof AI_ERROR_KINDS)[number];

/** Stable REST error codes for failures at an AI boundary. */
export const AI_FAILURE_CODES = {
  quota_exhausted: "ai_quota_exhausted",
  provider_billing: "ai_provider_billing",
  provider_credentials_rejected: "ai_provider_credentials_rejected",
  model_unavailable: "ai_model_unavailable",
  provider_unavailable: "ai_provider_unavailable",
  provider_stream_incomplete: "ai_provider_stream_incomplete",
  output_incomplete: "ai_output_incomplete",
  output_moderated: "ai_output_moderated",
  output_invalid: "ai_output_invalid",
  deadline_exceeded: "ai_deadline_exceeded",
  loop_detected: "ai_loop_detected",
  empty_completion: "ai_empty_completion",
  unknown: "ai_unknown",
  role_not_configured: "ai_role_not_configured",
  own_key_required: "ai_own_key_required",
  provider_task_unsupported: "ai_provider_task_unsupported",
  managed_provider_unavailable: "ai_managed_provider_unavailable",
} as const satisfies Record<AIErrorKind | AIFailureConfigurationKind, string>;

type AIFailureConfigurationKind =
  | "role_not_configured"
  | "own_key_required"
  | "provider_task_unsupported"
  | "managed_provider_unavailable";

export type AIFailureCode =
  (typeof AI_FAILURE_CODES)[keyof typeof AI_FAILURE_CODES];

const AI_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
  Object.values(AI_FAILURE_CODES),
);

/** Whether a handler's code is one of the AI failure codes. */
export const isAIFailureCode = (value: unknown): value is AIFailureCode =>
  typeof value === "string" && AI_FAILURE_CODE_SET.has(value);
