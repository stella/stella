// Shared constants for the domain-command runtime (spec 051).

/** The MCP JSON-RPC endpoint path, mirroring the server's `MCP_HTTP_PATH`. */
export const MCP_HTTP_PATH = "/mcp";

/** `--all` cursor-following ceilings (spec 051 S4). Bounded, moved client-side. */
export const MAX_ALL_PAGES = 50;
export const MAX_ALL_ITEMS = 10_000;
export const MAX_ALL_BYTES: number = 32 * 1024 * 1024;

/**
 * Machine codes a tool `isError` payload may carry to identify a disabled
 * `FEATURE_*` gate (spec 051 S4, exit 5). `feature` is not on the wire and is
 * per-org server state, so the CLI never gates a command client-side; it only
 * upgrades the exit class from 4 to 5 when the server tags the failure with one
 * of these codes. Until the server tags it, a feature error stays exit 4.
 */
export const FEATURE_DISABLED_ERROR_CODES: ReadonlySet<string> = new Set([
  "feature_disabled",
  "FEATURE_DISABLED",
]);

/** Exit-code classes (spec 051 S4), distinct per failure class. */
export const EXIT_CODES = {
  ok: 0,
  unexpected: 1,
  validation: 2,
  auth: 3,
  server: 4,
  featureDisabled: 5,
  notFound: 6,
  aborted: 7,
  permissionDenied: 8,
  usageLimited: 9,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Full map from a structured tool-error envelope `error.code` (the closed set in
 * `apps/api/src/mcp/error-codes.ts`) to the CLI exit class. Keyed by string (not
 * an imported server type) so `@stll/cli` stays free of any `apps/api` import;
 * an unknown/absent code falls through to the caller's server-error default.
 */
export const MCP_ERROR_CODE_EXIT_MAP: Readonly<Record<string, ExitCode>> = {
  validation_error: EXIT_CODES.validation,
  missing_scope: EXIT_CODES.auth,
  feature_disabled: EXIT_CODES.featureDisabled,
  not_found: EXIT_CODES.notFound,
  confirmation_required: EXIT_CODES.aborted,
  permission_denied: EXIT_CODES.permissionDenied,
  usage_limited: EXIT_CODES.usageLimited,
  rate_limited: EXIT_CODES.server,
  unknown_tool: EXIT_CODES.server,
  internal_error: EXIT_CODES.server,
};
