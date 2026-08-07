// Shared literal constants for the `stella auth` flow (spec 051 Phase 2).
//
// Several of these intentionally duplicate values owned by `apps/api`
// (`apps/api/src/mcp/constants.ts`, `apps/api/src/lib/auth.ts`). `packages/cli`
// cannot import from `apps/api` (apps depend on packages, never the reverse),
// and the MCP tool registry does not yet expose these as data the CLI could
// fetch at runtime. This is the same hand-duplication already accepted for
// `ToolScope` in `../route-types.ts`; keep both sides in sync by hand until a
// shared package exists.

/** Mirrors `apps/api/src/mcp/constants.ts`'s `MCP_HTTP_PATH`. */
const MCP_HTTP_PATH = "/mcp";

/**
 * The OAuth resource (`RFC 8707`) the CLI requests. Passing `resource` at the
 * token endpoint is what makes better-auth's oauth-provider mint a JWT-format
 * access token (see `checkResource`/`isJwtAccessToken` in
 * `@better-auth/oauth-provider`); without it the server returns an opaque
 * token that the CLI cannot decode for `stella auth whoami`.
 *
 * Derived from the resolved server URL, never the authorization-server
 * `issuer`: the API validates token audience against its public MCP URL
 * (`PUBLIC_URL ?? BETTER_AUTH_URL`, see `getMcpBaseUrl`), which is the host
 * the CLI targets, while the issuer may live on a different hostname in
 * split-host deployments.
 */
export const getMcpResourceUrl = (serverUrl: string): string =>
  new URL(MCP_HTTP_PATH, serverUrl).toString();

/**
 * Candidate RFC 8414 authorization-server-metadata paths, tried in order.
 * The first is the spec's root-issuer convention; the second matches
 * better-auth's actual (default `/api/auth`) mount point, which is what
 * stella's own server uses today. Self-hosted forks that change
 * `advanced.basePath` are covered as long as they keep one of these two
 * shapes; forks using a third convention are a follow-up, not a Phase 2 gap.
 */
export const AUTHORIZATION_SERVER_METADATA_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/api/auth/.well-known/oauth-authorization-server",
] as const;

/**
 * Loopback redirect URI registered with the OAuth client. Deliberately has no
 * port: better-auth's redirect-uri matcher (`isLoopbackIP` in
 * `@better-auth/core/utils/host`) only compares hostname/pathname/protocol/
 * search for loopback hosts, never the port (RFC 8252 S7.3). Registering a
 * portless URI once lets every login reuse the same client registration with
 * a fresh ephemeral port each run.
 */
export const LOOPBACK_REDIRECT_PATH = "/callback";
export const LOOPBACK_REDIRECT_URI: string = `http://127.0.0.1${LOOPBACK_REDIRECT_PATH}`;

/**
 * Default scopes requested when `stella auth login` is run without
 * `--scopes`. Includes `offline_access` so the stored credential carries a
 * refresh token; without it the access token dies after 15 minutes and
 * every command would demand a fresh browser login.
 */
export const CLI_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "stella:read",
  "stella:search",
] as const;

/** Minimum scopes needed for the default CLI login to be useful. */
export const CLI_REQUIRED_SCOPES = ["openid", "stella:read"] as const;

/** Every OAuth scope `stella auth login --scopes` is documented to accept. */
export const CLI_KNOWN_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "stella:search",
  "stella:read",
  "stella:templates",
  "stella:contacts_write",
  "stella:documents_write",
  "stella:matters_write",
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

/** Full resource scope surface the packaged CLI release expects its API to expose. */
export const CLI_REQUIRED_RESOURCE_SCOPES: readonly string[] =
  CLI_KNOWN_SCOPES.filter((scope) => scope.startsWith("stella:"));

export const CLIENT_NAME = "stella-cli";

/** `--server` resolution: env var name, checked between the flag and the config file. */
export const SERVER_URL_ENV_VAR = "STELLA_SERVER_URL";

/** How long the CLI waits for the browser round-trip before giving up. */
export const LOGIN_TIMEOUT_MS: number = 5 * 60 * 1000;

/** Network timeout for every discovery/registration/token request the CLI makes. */
export const AUTH_FETCH_TIMEOUT_MS = 10_000;
