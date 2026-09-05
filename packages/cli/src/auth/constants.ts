// Shared literal constants for the `stella auth` flow (spec 051 Phase 2).

import {
  CLI_KNOWN_SCOPES,
  CLI_REQUIRED_RESOURCE_SCOPES,
  MCP_HTTP_PATH,
} from "../generated/mcp-contract.js";

export { CLI_KNOWN_SCOPES, CLI_REQUIRED_RESOURCE_SCOPES };

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
 * Identity scopes every `stella auth login` requests, whatever `--scopes`
 * says. `offline_access` is what makes the provider issue a refresh token;
 * without it the access token dies after 15 minutes and every command would
 * demand a fresh browser login, and `openid` is what makes it issue the
 * `id_token` the CLI decodes for `whoami`. `--scopes` therefore selects
 * resource scopes only (see `auth/scopes.ts`).
 */
export const CLI_IDENTITY_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
] as const;

type CliResourceScope = (typeof CLI_REQUIRED_RESOURCE_SCOPES)[number];

/**
 * Resource scopes requested when `stella auth login` runs without `--scopes`:
 * the working set a user drives day to day (matters, documents, contacts,
 * templates, knowledge, billing, chat), so the first write does not fail with a
 * missing-scope error and a second browser round-trip. The consent screen
 * approves the bundle as a whole, so this is an explicit list rather than
 * "everything but": a scope added to the server's catalog is not requested
 * until someone decides it belongs here (`scopes.test.ts` fails until it is
 * placed in one of the two lists). `--scopes` selects an explicit set instead.
 */
export const CLI_DEFAULT_RESOURCE_SCOPES: readonly CliResourceScope[] = [
  "stella:read",
  "stella:search",
  "stella:templates",
  "stella:documents_write",
  "stella:matters_write",
  "stella:contacts_write",
  "stella:chat",
  "stella:knowledge_write",
  "stella:billing_write",
  "stella:admin_read",
  "stella:skills",
  "stella:feedback",
];

/** Resource scopes a default login leaves out: organization administration and one-off setup. */
export const CLI_NON_DEFAULT_RESOURCE_SCOPES: readonly CliResourceScope[] = [
  "stella:admin_write",
  "stella:onboarding",
  "stella:external_mcps",
];

/** Everything a default `stella auth login` asks for. */
export const CLI_DEFAULT_SCOPES: readonly string[] = [
  ...CLI_IDENTITY_SCOPES,
  ...CLI_DEFAULT_RESOURCE_SCOPES,
];

/** Minimum scopes needed for the default CLI login to be useful. */
export const CLI_REQUIRED_SCOPES = ["openid", "stella:read"] as const;

export const CLIENT_NAME = "stella-cli";

/** `--server` resolution: env var name, checked between the flag and the config file. */
export const SERVER_URL_ENV_VAR = "STELLA_SERVER_URL";

/** Machine credential; see `auth/resolve-access-token.ts`. */
export const API_KEY_ENV_VAR = "STELLA_API_KEY";

/** How long the CLI waits for the browser round-trip before giving up. */
export const LOGIN_TIMEOUT_MS: number = 5 * 60 * 1000;

/** Network timeout for every discovery/registration/token request the CLI makes. */
export const AUTH_FETCH_TIMEOUT_MS = 10_000;
