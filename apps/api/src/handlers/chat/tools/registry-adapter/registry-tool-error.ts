import type { ChatToolErrorKind } from "@/api/lib/errors/tagged-errors";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import type { McpErrorCode } from "@/api/mcp/error-codes";
import type { InternalToolError } from "@/api/mcp/tool-types";

const MCP_CODE_TO_CHAT_KIND = {
  validation_error: "invalid-input",
  missing_scope: "unavailable",
  feature_disabled: "unavailable",
  not_found: "not-found",
  confirmation_required: "invalid-input",
  permission_denied: "unavailable",
  usage_limited: "limit",
  // A 409 needs a different action (refetch state, rename, regenerate), which
  // is the model correcting its input, not a defect or a bare retry.
  conflict: "invalid-input",
  rate_limited: "transient",
  upstream_unavailable: "transient",
  unknown_tool: "unavailable",
  internal_error: "server-defect",
} as const satisfies Record<McpErrorCode, ChatToolErrorKind>;

/**
 * Classify a typed registry error directly. Legacy code-less plain-text errors
 * default to `invalid-input`: the conservative non-blocking kind, since a
 * wrong `server-defect` would suppress legitimate corrected retries.
 */
export const classifyRegistryErrorKind = (
  error: InternalToolError,
): ChatToolErrorKind =>
  error.type === "structured"
    ? MCP_CODE_TO_CHAT_KIND[error.code]
    : "invalid-input";

/**
 * Project one canonical internal tool error to the chat model boundary.
 * Plain-text errors stay plain. Structured errors retain the same stable
 * envelope agents receive over MCP, but this projection consumes the typed
 * error directly instead of serializing and reparsing an MCP response.
 */
export const toRegistryChatToolError = (
  error: InternalToolError,
): ChatToolError => {
  if (error.type === "text") {
    return new ChatToolError({
      kind: classifyRegistryErrorKind(error),
      message: error.message,
    });
  }

  const { type: _type, ...details } = error;
  return new ChatToolError({
    kind: classifyRegistryErrorKind(error),
    message: JSON.stringify({ error: details }),
  });
};
