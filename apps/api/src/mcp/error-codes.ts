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
  /**
   * The caller is authenticated and holds the required scope, but the member
   * role lacks permission for the operation (or workspace access was denied).
   * Maps a backing handler's 401/403 through the generic capability path; the
   * CLI keys exit code 8 off it.
   */
  "permission_denied",
  /**
   * The operation would exceed the organization's usage entitlement (a backing
   * handler's 402). Distinct from `rate_limited` (a transient window) and
   * `permission_denied` (an authorization gap): retrying without freeing usage
   * will not succeed. The CLI keys exit code 9 off it.
   */
  "usage_limited",
  /**
   * The request is valid but conflicts with current state (a backing handler's
   * 409): duplicate link, name already taken, concurrent edit. Distinct from
   * `validation_error` (the input itself is well-formed) and `not_found`; the
   * handler's message names the conflicting resource. The CLI keys exit code
   * 10 off it.
   */
  "conflict",
  /** The caller exceeded a rate limit; retry after the window. */
  "rate_limited",
  /** No tool with the given name is exposed on this surface. */
  "unknown_tool",
  /** An unexpected server-side failure; details are not leaked to the caller. */
  "internal_error",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

/**
 * Map a backing safe handler's HTTP-ish status onto a stable envelope code,
 * preserving the handler's curated message at the call site. Mirrors the sweep
 * of 4xx statuses the handlers actually return:
 *  - 400 / 413 / 422 -> `validation_error` (shape, payload size, semantic);
 *  - 401 / 403 -> `permission_denied` (the tool paths are always authenticated,
 *    so a 401 here is an authorization gap, not a login prompt);
 *  - 402 -> `usage_limited`; 404 -> `not_found`; 409 -> `conflict`;
 *  - 429 -> `rate_limited`.
 * Any other status (5xx, or an unmapped value) is a genuine server failure whose
 * detail must not leak, so it falls through to `internal_error`.
 */
export const statusCodeToErrorCode = (status: number): McpErrorCode => {
  switch (status) {
    case 400:
    case 413:
    case 422:
      return "validation_error";
    case 401:
    case 403:
      return "permission_denied";
    case 402:
      return "usage_limited";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    default:
      return "internal_error";
  }
};

/**
 * One structured validation issue in the error envelope. `path` is the dot-path
 * to the offending field (empty string for a whole-object / root issue);
 * `message` is the human-readable reason. Emitted under `error.issues` only for
 * `validation_error` envelopes, so agents and the CLI can pinpoint the field
 * that failed instead of parsing the collapsed summary message.
 */
export type McpValidationIssue = { path: string; message: string };
