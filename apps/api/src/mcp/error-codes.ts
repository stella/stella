/**
 * Machine-readable error codes for the MCP tool-error envelope. The MCP server
 * is used almost exclusively by AI agents (and the companion CLI), so every
 * tool error carries one of these stable codes alongside a human message and an
 * actionable `hint`. Agents branch on the code; the CLI maps it to an exit code
 * (e.g. `feature_disabled` -> exit 5, see `packages/cli`). The set is closed: a
 * new failure mode must pick an existing code or add one here deliberately.
 */
export const MCP_ERROR_CODES = [
  /** Input failed validation at the tool boundary (shape, type, range). */
  "validation_error",
  /** The session lacks the OAuth scope the tool requires. */
  "missing_scope",
  /** The tool's backing feature is turned off for this deployment/org. */
  "feature_disabled",
  /** The named resource does not exist or the caller cannot access it. */
  "not_found",
  /** A destructive operation needs `confirm: true` after human approval. */
  "confirmation_required",
  /** The caller exceeded a rate limit; retry after the window. */
  "rate_limited",
  /** No tool with the given name is exposed on this surface. */
  "unknown_tool",
  /** An unexpected server-side failure; details are not leaked to the caller. */
  "internal_error",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];
