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
  /** The request conflicts with current state (server `conflict` / HTTP 409). */
  conflict: 10,
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
  conflict: EXIT_CODES.conflict,
  rate_limited: EXIT_CODES.server,
  unknown_tool: EXIT_CODES.server,
  internal_error: EXIT_CODES.server,
};

/**
 * Maps a transport-level HTTP status (`McpClientError.httpStatus`) to the CLI
 * exit class (spec 051 S4). Every executor that surfaces `kind: "http"`
 * errors (`run-leaf-command.ts`'s `mapClientErrorExit`,
 * `run-resource-command.ts`'s `mapResourceErrorExit`) must route through this
 * one function so the HTTP-status mapping cannot drift between them; 403 is a
 * transport-level organization-access denial (distinct from the
 * `permission_denied` tool-error envelope code above, which arrives inside a
 * 200 response) and must not be folded into the generic server-error class,
 * or callers cannot distinguish "don't retry" from "retry".
 */
export const mapHttpStatusExit = (httpStatus: number | undefined): ExitCode => {
  if (httpStatus === 401) {
    return EXIT_CODES.auth;
  }
  if (httpStatus === 403) {
    return EXIT_CODES.permissionDenied;
  }
  if (httpStatus === 404) {
    return EXIT_CODES.notFound;
  }
  if (httpStatus === 409) {
    return EXIT_CODES.conflict;
  }
  return EXIT_CODES.server;
};
