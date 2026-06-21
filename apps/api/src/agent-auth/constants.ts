import {
  getMcpBaseUrl,
  MCP_ANONYMIZED_RESOURCE_SCOPES,
} from "@/api/mcp/constants";

/**
 * auth.md protocol version we implement. Kept in lockstep with the pin in
 * packages/scripts/src/auth-md-spec.lock.json; the scheduled spec-drift
 * check flags upstream movement so this and our handlers can be updated
 * together.
 */
export const AUTH_MD_SPEC_VERSION = "0.6.0" as const;

/** The skill manifest agents read (`agent_auth.skill`). */
export const AGENT_AUTH_MANIFEST_PATH = "/auth.md" as const;

export const AGENT_AUTH_IDENTITY_PATH = "/agent/identity" as const;
export const AGENT_AUTH_CLAIM_PATH = "/agent/identity/claim" as const;
export const AGENT_AUTH_EVENTS_PATH = "/agent/event/notify" as const;
/**
 * Profile-specific token exchanges (claim-grant polling and RFC 7523
 * jwt-bearer) live here, NOT on better-auth's /oauth2/token: its GrantType
 * union is closed, so these grant URNs cannot be registered there.
 */
export const AGENT_AUTH_TOKEN_PATH = "/agent/token" as const;

/** Registration methods accepted at the identity endpoint. */
export const AGENT_AUTH_IDENTITY_TYPES = [
  "service_auth",
  "anonymous",
  "identity_assertion",
] as const;

/** The single assertion type ID-JAG carries (RFC 9396 / OAuth ID-JAG). */
export const AGENT_AUTH_ID_JAG_ASSERTION_TYPE =
  "urn:ietf:params:oauth:token-type:id-jag" as const;

/** Assertion types accepted under the identity_assertion shape (ID-JAG). */
export const AGENT_AUTH_ASSERTION_TYPES = [
  AGENT_AUTH_ID_JAG_ASSERTION_TYPE,
] as const;

/** RFC 8935 security-event schemas we can ingest at the events endpoint. */
export const AGENT_AUTH_EVENTS_SUPPORTED = [
  "https://schemas.workos.com/events/agent/auth/identity/assertion/revoked",
] as const;

/** Claim-ceremony polling grant (Step 4c). */
export const AGENT_AUTH_CLAIM_GRANT_TYPE =
  "urn:workos:agent-auth:grant-type:claim" as const;

/** Identity-assertion exchange grant (Step 5, RFC 7523). */
export const AGENT_AUTH_JWT_BEARER_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:jwt-bearer" as const;

const withTrailingSlash = (url: string) => `${url.replace(/\/$/u, "")}/`;

/** Public origin the agent-auth surface (manifest + endpoints) is served from. */
export const getAgentAuthBaseUrl = () => getMcpBaseUrl();

export const getAgentAuthUrl = (path: string) =>
  new URL(
    path.replace(/^\//u, ""),
    withTrailingSlash(getAgentAuthBaseUrl()),
  ).toString();

export const getAgentAuthManifestUrl = () =>
  getAgentAuthUrl(AGENT_AUTH_MANIFEST_PATH);

/** Session-authenticated endpoint the web claim page POSTs to. */
export const AGENT_AUTH_CONFIRM_PATH = "/agent/identity/confirm" as const;

/**
 * Lifecycle of a registration. `pending` awaits a human claim;
 * `claimed` has an authorization code ready to exchange; `denied` was
 * rejected by the human; `expired` outlived `expiresAt`.
 */
export const AGENT_REGISTRATION_STATUSES = [
  "pending",
  "claimed",
  "denied",
  "expired",
] as const;

export type AgentRegistrationStatus =
  (typeof AGENT_REGISTRATION_STATUSES)[number];

/** Identity types this phase implements end to end. */
export const AGENT_AUTH_REGISTRABLE_TYPES = [
  "service_auth",
  "anonymous",
  "identity_assertion",
] as const;

export type AgentRegistrationType =
  (typeof AGENT_AUTH_REGISTRABLE_TYPES)[number];

/**
 * JOSE `typ` an inbound ID-JAG (and the service-issued intermediate
 * assertion) must declare. Anything else is rejected before signature
 * verification so a generic JWT cannot be replayed here.
 */
export const AGENT_AUTH_ID_JAG_JWT_TYP = "oauth-id-jag+jwt" as const;

/**
 * Asymmetric algorithms we accept for ID-JAG signatures. `none` and every
 * HMAC/symmetric alg are rejected: a symmetric alg would let an attacker
 * who learns a published JWKS value forge assertions.
 */
export const AGENT_AUTH_ID_JAG_ALLOWED_ALGS = [
  "ES256",
  "RS256",
  "EdDSA",
] as const;

/**
 * Maximum age of the upstream `auth_time` we accept on an ID-JAG. A stale
 * authentication forces the agent platform to re-authenticate the human
 * (the spec's `login_required`).
 */
export const AGENT_AUTH_ID_JAG_MAX_AUTH_AGE_SECONDS = 3600;

/**
 * Tolerance, in seconds, for a future-dated `iat`/`auth_time` to absorb
 * clock skew between the issuer and us before treating the claim as
 * unreasonably in the future.
 */
export const AGENT_AUTH_ID_JAG_CLOCK_SKEW_SECONDS = 60;

/** Lifetime of the service-issued intermediate identity_assertion. */
export const AGENT_AUTH_ASSERTION_TTL_SECONDS = 5 * 60;

/** Bounded JWKS cache window for `createRemoteJWKSet`. */
export const AGENT_AUTH_JWKS_CACHE_MIN_MS = 10 * 60 * 1000;
export const AGENT_AUTH_JWKS_CACHE_MAX_MS = 24 * 60 * 60 * 1000;

/** Timeout for the issuer JWKS fetch. */
export const AGENT_AUTH_JWKS_FETCH_TIMEOUT_MS = 10_000;

/** Ceremony lifetime: how long a `user_code` stays claimable. */
export const AGENT_AUTH_CEREMONY_TTL_SECONDS = 15 * 60;

/** Minimum seconds an agent must wait between `/agent/token` polls. */
export const AGENT_AUTH_POLL_INTERVAL_SECONDS = 5;

/**
 * User-code charset and length (RFC 8628 style). Excludes ambiguous
 * glyphs (0/O, 1/I) so a human can read the code aloud or retype it.
 */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;

export const generateUserCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH));
  let code = "";
  for (const byte of bytes) {
    code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};

/** Scopes granted to a user-claimed (service_auth) agent. */
export const AGENT_AUTH_SERVICE_SCOPES = [
  "stella:read",
  "stella:search",
] as const;

/** Scopes an anonymous agent receives (no org principal). */
export const AGENT_AUTH_ANONYMOUS_SCOPES = MCP_ANONYMIZED_RESOURCE_SCOPES;
