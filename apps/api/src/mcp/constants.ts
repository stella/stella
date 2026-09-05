import {
  MCP_ANONYMIZED_HTTP_PATH,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_DOCUMENTS_HTTP_PATH,
  MCP_HTTP_PATH,
  MCP_OAUTH_PROTOCOL_SCOPES,
  type McpOAuthScope,
} from "@stll/api-contract";

import { env } from "@/api/env";
import { REQUEST_ID_HEADER } from "@/api/lib/observability/request-context";
import { declareCliSupportBand } from "@/api/mcp/cli-support-band";
import {
  getMcpResourceModeConfig,
  getMcpResourceScopes,
  MCP_ANONYMIZED_DISCOVERY_PATH,
  MCP_DISCOVERY_PATH,
  MCP_DOCUMENTS_RESOURCE_SCOPES,
  MCP_DOCUMENTS_DISCOVERY_PATH,
  MCP_MODES,
  ROOT_MCP_DISCOVERY_PATH,
} from "@/api/mcp/resource-policy-contract";
import type { McpMode } from "@/api/mcp/resource-policy-contract";

export {
  MCP_ANONYMIZED_RESOURCE_SCOPES,
  MCP_ANONYMIZED_SCOPE_BY_DEFAULT_SCOPE,
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_OAUTH_PROTOCOL_SCOPES,
};

export { MCP_DOCUMENTS_RESOURCE_SCOPES, MCP_MODES };
export type { McpMode };

export const MCP_ALL_RESOURCE_SCOPES = [
  ...MCP_DEFAULT_RESOURCE_SCOPES,
  ...MCP_ANONYMIZED_RESOURCE_SCOPES,
] as const;

export const MCP_OAUTH_SCOPES = [
  ...MCP_OAUTH_PROTOCOL_SCOPES,
  ...MCP_ALL_RESOURCE_SCOPES,
] as const;

/**
 * Every scope the OAuth provider can grant (see `oauthProvider({ scopes: ... })`
 * in `lib/auth.ts`). The consent page types its scope-label map against this
 * union so a newly added scope fails the build instead of silently rendering
 * without a disclosure line.
 */
export type { McpOAuthScope };

export { MCP_ANONYMIZED_HTTP_PATH, MCP_DOCUMENTS_HTTP_PATH, MCP_HTTP_PATH };

/**
 * What the stateless transport serves. `GET` opens a request-scoped
 * notification stream for clients that require one (notably ChatGPT), while
 * `POST` remains the stateless JSON-RPC exchange. `DELETE` still presupposes a
 * resumable session and is not advertised. Shared so the endpoint and anything
 * probing it cannot drift apart on the contract.
 */
export const MCP_STATELESS_ALLOW_HEADER = "OPTIONS, GET, POST";

/** What the protected-resource discovery documents serve. */
export const MCP_DISCOVERY_ALLOW_HEADER = "GET, OPTIONS";

/**
 * Frame cap for a JSON-RPC request body, refused before anything parses it.
 * Every legitimate tool call fits far below this: document bytes travel out of
 * band through presigned uploads, never inside a tool argument.
 */
export const MCP_MAX_REQUEST_BODY_BYTES = 512 * 1024;

/**
 * The first frame on an otherwise idle notification stream. Keep this well
 * below edge/request deadlines: the canary derives its fetch timeout from the
 * same value, so transport and observer cannot silently drift apart.
 */
export const MCP_NOTIFICATION_KEEP_ALIVE_MS = 5000;

export {
  MCP_ANONYMIZED_DISCOVERY_PATH,
  MCP_DISCOVERY_PATH,
  MCP_DOCUMENTS_DISCOVERY_PATH,
  ROOT_MCP_DISCOVERY_PATH,
};

export const MCP_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "MCP-Protocol-Version",
] as const;

// Public protocol/revision contract advertised by protected-resource
// discovery. CLI package versions are deliberately absent: compatibility is a
// property of the wire protocol and capabilities, not release numbering.
export const STELLA_API_CONTRACT = {
  protocol: 1,
  // 2: the agent surface renamed the client-engagement container to "matter"
  // (tool inputs, capability ids, capability params), with no alias.
  revision: 2,
  capabilities: {
    "document-version-upload": 1,
    "mcp-v2-transport": 1,
  },
} as const;

// Retained as a response header and in the legacy discovery object for clients
// published before `stella_contract` existed.
export const STELLA_MCP_API_CONTRACT_VERSION = STELLA_API_CONTRACT.protocol;

// Legacy package-version band. Freeze the ceiling at the transition CLI:
// future CLIs negotiate `STELLA_API_CONTRACT` and never require another bump.
const CLI_SUPPORT_BAND = declareCliSupportBand({
  minimum: "0.3.0",
  maximum: "0.4.3",
});

export const STELLA_CLI_MINIMUM_VERSION = CLI_SUPPORT_BAND.minimum;
export const STELLA_CLI_MAXIMUM_VERSION = CLI_SUPPORT_BAND.maximum;
export const STELLA_MCP_API_CONTRACT_HEADER = "x-stella-api-contract-version";
export const STELLA_CLI_MINIMUM_HEADER = "x-stella-cli-minimum";

// Identity of the authenticated session, echoed back to the caller on every
// authenticated MCP response so `stella auth whoami` can confirm which org and
// scopes an opaque machine API key actually resolves to (the key is not a JWT
// the CLI can decode). Returned only to the already-authenticated caller: it is
// that caller's own org and grants, not a disclosure to anyone else.
export const STELLA_MCP_ORGANIZATION_HEADER = "x-stella-organization";
export const STELLA_MCP_SCOPES_HEADER = "x-stella-scopes";

/**
 * Why an authenticated tools/list projection left a static tool out. A client
 * diffs its baked-in registry against that projection, so an omission the
 * server does not state reads as a removal and never reconciles. Closed set:
 * every omission is attested under exactly one reason.
 */
export const MCP_TOOL_OMISSION_REASONS = ["scope", "feature"] as const;
export type McpToolOmissionReason = (typeof MCP_TOOL_OMISSION_REASONS)[number];

// One response header per reason, carrying the exact omitted tool names. This
// is deliberately per-tool evidence: a grants-only (or flags-only) header
// cannot distinguish an omission from a tool an older server never implemented.
export const STELLA_MCP_OMITTED_TOOLS_HEADER_BY_REASON = {
  scope: "x-stella-scope-omitted-tools",
  feature: "x-stella-feature-omitted-tools",
} as const satisfies Record<McpToolOmissionReason, string>;

export const MCP_EXPOSE_HEADERS = [
  "WWW-Authenticate",
  STELLA_MCP_API_CONTRACT_HEADER,
  STELLA_CLI_MINIMUM_HEADER,
  STELLA_MCP_ORGANIZATION_HEADER,
  STELLA_MCP_SCOPES_HEADER,
  ...MCP_TOOL_OMISSION_REASONS.map(
    (reason) => STELLA_MCP_OMITTED_TOOLS_HEADER_BY_REASON[reason],
  ),
  // The per-request receipt (also on the global CORS exposeHeaders list):
  // browser-based MCP clients correlate a failed/successful call with server
  // logs the same way REST callers do.
  REQUEST_ID_HEADER,
] as const;

export { getMcpResourceScopes };

export const getMcpBaseUrl = () => env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

export const getMcpResourceUrl = (mode: McpMode = "default") =>
  new URL(
    getMcpResourceModeConfig(mode).httpPath,
    `${getMcpBaseUrl().replace(/\/$/u, "")}/`,
  ).toString();

export const getMcpResourceUrls = () =>
  MCP_MODES.map((mode) => getMcpResourceUrl(mode));

export const getMcpProtectedResourceMetadataUrl = (mode: McpMode = "default") =>
  new URL(
    getMcpResourceModeConfig(mode).discoveryPath,
    `${getMcpBaseUrl().replace(/\/$/u, "")}/`,
  ).toString();
