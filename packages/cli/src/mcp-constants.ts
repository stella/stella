// Shared constants for the domain-command runtime (spec 051).

/** The MCP JSON-RPC endpoint path, mirroring the server's `MCP_HTTP_PATH`. */
export const MCP_HTTP_PATH = "/mcp";

/** `--all` cursor-following ceilings (spec 051 S4). Bounded, moved client-side. */
export const MAX_ALL_PAGES = 50;
export const MAX_ALL_ITEMS = 10_000;
export const MAX_ALL_BYTES: number = 32 * 1024 * 1024;

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
