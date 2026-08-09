import { env } from "@/api/env";
import { REQUEST_ID_HEADER } from "@/api/lib/observability/request-context";
import { declareCliSupportBand } from "@/api/mcp/cli-support-band";

export const MCP_DEFAULT_RESOURCE_SCOPES = [
  "stella:search",
  "stella:read",
  "stella:templates",
  "stella:documents_write",
  "stella:matters_write",
  "stella:contacts_write",
  "stella:chat",
  "stella:knowledge_write",
  "stella:billing_write",
  "stella:admin_read",
  "stella:admin_write",
  "stella:onboarding",
  "stella:skills",
  "stella:external_mcps",
  "stella:feedback",
] as const;

export const MCP_ANONYMIZED_RESOURCE_SCOPES = [
  "stella:search_anonymized",
  "stella:read_anonymized",
  "stella:templates_anonymized",
] as const;

/**
 * Least-privilege remote-host surface for document workflows. Hosted clients
 * commonly request every scope in protected-resource metadata, so this
 * resource advertises only the grants its projected tool registry can use.
 */
export const MCP_DOCUMENTS_RESOURCE_SCOPES = [
  "stella:read",
  "stella:documents_write",
  // The canonical presigned-upload lifecycle currently owns one scope across
  // entity-create and entity-version purposes. The documents MCP audience
  // restricts invoke_capability to the three lifecycle IDs, so this grant does
  // not expose unrelated matter mutations through that endpoint.
  "stella:matters_write",
] as const;

export const MCP_ALL_RESOURCE_SCOPES = [
  ...MCP_DEFAULT_RESOURCE_SCOPES,
  ...MCP_ANONYMIZED_RESOURCE_SCOPES,
] as const;

export const MCP_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  // Protocol scope (RFC 6749 / OIDC), not a stella resource scope: it must
  // never leak into `MCP_ALL_RESOURCE_SCOPES` or the resource-metadata scope
  // lists derived from it. Granting it is what makes
  // `oauthProvider({ scopes: ... })` in `lib/auth.ts` issue a refresh token
  // alongside the access token.
  "offline_access",
  ...MCP_ALL_RESOURCE_SCOPES,
] as const;

/**
 * Every scope the OAuth provider can grant (see `oauthProvider({ scopes: ... })`
 * in `lib/auth.ts`). The consent page types its scope-label map against this
 * union so a newly added scope fails the build instead of silently rendering
 * without a disclosure line.
 */
export type McpOAuthScope = (typeof MCP_OAUTH_SCOPES)[number];

export const MCP_HTTP_PATH = "/mcp";
export const MCP_DOCUMENTS_HTTP_PATH = "/mcp-documents";
export const MCP_ANONYMIZED_HTTP_PATH = "/mcp-anonymized";

/**
 * What the stateless transport serves. `GET` opens a request-scoped
 * notification stream for clients that require one (notably ChatGPT), while
 * `POST` remains the stateless JSON-RPC exchange. `DELETE` still presupposes a
 * resumable session and is not advertised. Shared so the endpoint and anything
 * probing it cannot drift apart on the contract.
 */
export const MCP_STATELESS_ALLOW_HEADER = "OPTIONS, GET, POST";

/**
 * The first frame on an otherwise idle notification stream. Keep this well
 * below edge/request deadlines: the canary derives its fetch timeout from the
 * same value, so transport and observer cannot silently drift apart.
 */
export const MCP_NOTIFICATION_KEEP_ALIVE_MS = 5000;

export const ROOT_MCP_DISCOVERY_PATH =
  "/.well-known/oauth-protected-resource" as const;

export const MCP_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_HTTP_PATH}` as const;

export const MCP_DOCUMENTS_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_DOCUMENTS_HTTP_PATH}` as const;

export const MCP_ANONYMIZED_DISCOVERY_PATH =
  `/.well-known/oauth-protected-resource${MCP_ANONYMIZED_HTTP_PATH}` as const;

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
  revision: 1,
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
// Exact static tool names that this authenticated tools/list projection omitted
// solely because the token lacks the tool's primary scope. This is deliberately
// per-tool evidence: a grants-only header cannot distinguish a scoped omission
// from a tool that an older server does not implement at all.
export const STELLA_MCP_SCOPE_OMITTED_TOOLS_HEADER =
  "x-stella-scope-omitted-tools";

export const MCP_EXPOSE_HEADERS = [
  "WWW-Authenticate",
  STELLA_MCP_API_CONTRACT_HEADER,
  STELLA_CLI_MINIMUM_HEADER,
  STELLA_MCP_ORGANIZATION_HEADER,
  STELLA_MCP_SCOPES_HEADER,
  STELLA_MCP_SCOPE_OMITTED_TOOLS_HEADER,
  // The per-request receipt (also on the global CORS exposeHeaders list):
  // browser-based MCP clients correlate a failed/successful call with server
  // logs the same way REST callers do.
  REQUEST_ID_HEADER,
] as const;

const MCP_MODE_CONFIG = {
  default: {
    discoveryPath: MCP_DISCOVERY_PATH,
    httpPath: MCP_HTTP_PATH,
    resourceScopes: MCP_DEFAULT_RESOURCE_SCOPES,
  },
  documents: {
    discoveryPath: MCP_DOCUMENTS_DISCOVERY_PATH,
    httpPath: MCP_DOCUMENTS_HTTP_PATH,
    resourceScopes: MCP_DOCUMENTS_RESOURCE_SCOPES,
  },
  anonymized: {
    discoveryPath: MCP_ANONYMIZED_DISCOVERY_PATH,
    httpPath: MCP_ANONYMIZED_HTTP_PATH,
    resourceScopes: MCP_ANONYMIZED_RESOURCE_SCOPES,
  },
} as const;

export type McpMode = keyof typeof MCP_MODE_CONFIG;

export const MCP_MODES = [
  "default",
  "documents",
  "anonymized",
] as const satisfies readonly McpMode[];

const getMcpModeConfig = (mode: McpMode) => MCP_MODE_CONFIG[mode];

export const getMcpResourceScopes = (mode: McpMode) =>
  getMcpModeConfig(mode).resourceScopes;

export const getMcpBaseUrl = () => env.PUBLIC_URL ?? env.BETTER_AUTH_URL;

export const getMcpResourceUrl = (mode: McpMode = "default") =>
  new URL(
    getMcpModeConfig(mode).httpPath,
    `${getMcpBaseUrl().replace(/\/$/u, "")}/`,
  ).toString();

export const getMcpResourceUrls = () =>
  MCP_MODES.map((mode) => getMcpResourceUrl(mode));

export const getMcpProtectedResourceMetadataUrl = (mode: McpMode = "default") =>
  new URL(
    getMcpModeConfig(mode).discoveryPath,
    `${getMcpBaseUrl().replace(/\/$/u, "")}/`,
  ).toString();
