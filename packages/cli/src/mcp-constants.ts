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
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
