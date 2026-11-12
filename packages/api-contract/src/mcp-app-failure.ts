import * as v from "valibot";

export const mcpAppRequestIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
);
export const mcpAppFailureSchema = v.object({
  type: v.picklist([
    "invalid_arguments",
    "unavailable",
    "cancelled",
    "invalid_response",
    "tool_failure",
    "permission_denied",
    "not_found",
    "rate_limited",
    "conflict",
    "feature_disabled",
    "usage_limited",
  ]),
  requestId: mcpAppRequestIdSchema,
  retryable: v.boolean(),
  fields: v.array(v.string()),
  toolCode: v.string(),
});
export const mcpAppFailureEnvelopeSchema = v.object({
  appFailure: mcpAppFailureSchema,
});
export type McpAppFailure = v.InferOutput<typeof mcpAppFailureSchema>;
