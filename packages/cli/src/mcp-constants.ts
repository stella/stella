// Shared constants for the domain-command runtime (spec 051).

import { panic } from "better-result";

import {
  MCP_ERROR_CODES,
  type McpErrorCode,
} from "./generated/mcp-contract.js";

export { MCP_HTTP_PATH } from "./generated/mcp-contract.js";

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
 * Human meaning for each `EXIT_CODES` key, typed `satisfies Record<keyof typeof
 * EXIT_CODES, string>` so a new exit code fails typecheck here until it is
 * described. Every surface that documents exit codes (the root `--help`, the
 * generated agent skill) renders `exitCodeEntries()` instead of its own list,
 * so no copy can drift from the compiled constant.
 */
const EXIT_CODE_DESCRIPTIONS = {
  ok: "success",
  unexpected: "unexpected internal error",
  validation: "usage or input validation error",
  auth: "authentication required or failed (run `stella auth login`)",
  server: "server or tool error",
  featureDisabled: "feature disabled for this organization",
  notFound: "resource not found",
  aborted: "confirmation aborted (a destructive op was declined)",
  permissionDenied:
    "permission denied (member role lacks the required permission)",
  usageLimited: "usage entitlement exceeded",
  conflict: "conflict with current state (duplicate or concurrent change)",
} satisfies Record<keyof typeof EXIT_CODES, string>;

export type ExitCodeEntry = { readonly code: number; readonly meaning: string };

/** Every exit code with its meaning, ordered numerically. */
export const exitCodeEntries = (): readonly ExitCodeEntry[] => {
  // Iterate `EXIT_CODES` (the source of truth) and look descriptions up through
  // a widened alias, so no cast is needed: exhaustiveness is already
  // compile-forced on the `EXIT_CODE_DESCRIPTIONS` literal by its `satisfies`.
  const descriptions: Record<string, string> = EXIT_CODE_DESCRIPTIONS;
  return Object.entries(EXIT_CODES)
    .toSorted(([, a], [, b]) => a - b)
    .map(([key, code]) => ({
      code,
      meaning:
        descriptions[key] ?? panic(`exit code ${key} has no description`),
    }));
};

/**
 * Full map from a structured tool-error envelope `error.code` to the CLI exit
 * class. The generated error-code union makes a new server code a compile-time
 * decision here. The npm-published CLI and API deploy independently within one
 * protocol, so a code unknown to this CLI falls through to the caller's generic
 * server-error class. Remove that fallback only if releases become lockstep or a
 * protocol revision guarantees an exact error-code set.
 */
const MCP_ERROR_CODE_EXIT_MAP = {
  validation_error: EXIT_CODES.validation,
  missing_scope: EXIT_CODES.auth,
  feature_disabled: EXIT_CODES.featureDisabled,
  not_found: EXIT_CODES.notFound,
  confirmation_required: EXIT_CODES.aborted,
  permission_denied: EXIT_CODES.permissionDenied,
  usage_limited: EXIT_CODES.usageLimited,
  conflict: EXIT_CODES.conflict,
  rate_limited: EXIT_CODES.server,
  upstream_unavailable: EXIT_CODES.server,
  unknown_tool: EXIT_CODES.server,
  internal_error: EXIT_CODES.server,
} as const satisfies Record<McpErrorCode, ExitCode>;

const isMcpErrorCode = (code: string): code is McpErrorCode =>
  MCP_ERROR_CODES.some((candidate) => candidate === code);

export const resolveMcpErrorCodeExit = (code: string): ExitCode | undefined =>
  isMcpErrorCode(code) ? MCP_ERROR_CODE_EXIT_MAP[code] : undefined;

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
