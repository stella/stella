import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  AGENT_AUTH_ANONYMOUS_SCOPES,
  AGENT_AUTH_CEREMONY_TTL_SECONDS,
  AGENT_AUTH_POLL_INTERVAL_SECONDS,
  AGENT_AUTH_SERVICE_SCOPES,
  generateUserCode,
} from "@/api/agent-auth/constants";
import type {
  AgentRegistrationStatus,
  AgentRegistrationType,
} from "@/api/agent-auth/constants";
import { agentRegistration } from "@/api/db/agent-auth-schema";
import { oauthClient, session } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl, getAuthIssuerUrl } from "@/api/lib/auth-paths";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";

/**
 * The OAuth redirect URI bound to every agent client. It is never
 * navigated to: the authorization code is read server-side from the
 * authorize response and handed back to the agent through our own
 * `/agent/token` endpoint, never to a browser. It only has to satisfy
 * better-auth's exact redirect-uri match at authorize and token time, so
 * it points at an internal, handler-less path under our own origin.
 */
const AGENT_REDIRECT_URI =
  `${getAuthIssuerUrl()}/agent/internal/code-sink` as const;

/** How long an unconsumed claim token / registration row stays valid. */
const REGISTRATION_TTL_MS = AGENT_AUTH_CEREMONY_TTL_SECONDS * 1000;

const sha256Hex = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

/**
 * better-auth's default `storeClientSecret: "hashed"` form: SHA-256 of
 * the secret, base64url without padding. Reproduced here so we can mint
 * a confidential agent client by inserting the row directly (the admin
 * create-client endpoint requires an interactive session we do not have
 * at registration time). Kept in lockstep with `defaultHasher` in
 * `@better-auth/oauth-provider`.
 */
const hashClientSecret = (secret: string): string =>
  new Bun.CryptoHasher("sha256").update(secret).digest("base64url");

export const generateOpaqueToken = (): string =>
  Bun.randomUUIDv7().replaceAll("-", "") +
  Bun.randomUUIDv7().replaceAll("-", "");

export const hashClaimToken = (token: string): string => sha256Hex(token);

const getResourceModeForType = (
  registrationType: AgentRegistrationType,
): McpMode => (registrationType === "service_auth" ? "default" : "anonymized");

type OAuth2TokenBody = Record<string, string>;

type OAuth2TokenApi = {
  oauth2Token: (args: { body: OAuth2TokenBody }) => Promise<unknown>;
};

const hasOAuth2Token = (api: object): api is OAuth2TokenApi =>
  "oauth2Token" in api && typeof api.oauth2Token === "function";

/**
 * better-auth's oauthProvider registers /oauth2/token at runtime, but its
 * plugin endpoints are not surfaced on the inferred `api` type. Reach it
 * through a structural guard (mirrors `hasOAuthServerConfig` in
 * handlers/auth/metadata.ts) so call sites stay cast-free.
 */
const callOauth2Token = async (body: OAuth2TokenBody): Promise<unknown> => {
  const { api } = getAuth();
  if (!hasOAuth2Token(api)) {
    panic("OAuth2 token endpoint is unavailable");
  }
  return await api.oauth2Token({ body });
};

type AgentClientCredentials = { clientId: string; clientSecret: string };

/**
 * Insert a confidential, first-party agent OAuth client. PKCE is forced
 * on for public clients, so the agent client instead holds a secret that
 * never leaves the server: we exchange the authorization code on the
 * agent's behalf at `/agent/token`. `skipConsent` lets the server-side
 * authorize issue a code without a consent page.
 */
export const createAgentOAuthClient = async ({
  registrationType,
  registrationId,
  scopes,
  grantTypes,
}: {
  registrationType: AgentRegistrationType;
  registrationId: string;
  scopes: readonly string[];
  grantTypes: readonly string[];
}): Promise<AgentClientCredentials> => {
  const clientId = Bun.randomUUIDv7().replaceAll("-", "");
  const clientSecret = generateOpaqueToken();

  await rootDb.insert(oauthClient).values({
    id: createSafeId<"mcpOAuthClient">(),
    clientId,
    clientSecret: hashClientSecret(clientSecret),
    public: false,
    skipConsent: true,
    requirePKCE: false,
    type: "web",
    name: "stella agent",
    scopes: [...scopes],
    redirectUris: [AGENT_REDIRECT_URI],
    grantTypes: [...grantTypes],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "client_secret_post",
    metadata: { agent: true, identityType: registrationType, registrationId },
  });

  return { clientId, clientSecret };
};

export type TokenResponseShape = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
};

export const isTokenResponse = (
  value: unknown,
): value is TokenResponseShape => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "access_token" in value &&
    typeof value.access_token === "string" &&
    "expires_in" in value &&
    typeof value.expires_in === "number" &&
    "scope" in value &&
    typeof value.scope === "string"
  );
};

export const reshapeTokenResponse = (
  value: TokenResponseShape,
): TokenResponseShape => ({
  access_token: value.access_token,
  token_type: "Bearer",
  expires_in: value.expires_in,
  scope: value.scope,
});

/** The redirect URI every agent client is bound to (never navigated to). */
export const getAgentRedirectUri = (): string => AGENT_REDIRECT_URI;

/**
 * Exchange a stored authorization code for an MCP-audience JWT using the
 * agent client's confidential credentials. Shared by the claim-grant poll
 * and the ID-JAG jwt-bearer grant: both already hold a one-shot code on
 * the registration row. The resource is always the default MCP audience
 * (ID-JAG agents act as a real org member).
 */
export const exchangeAuthorizationCode = async ({
  clientId,
  clientSecret,
  code,
  resourceMode,
}: {
  clientId: string;
  clientSecret: string;
  code: string;
  resourceMode: McpMode;
}): Promise<Result<TokenResponseShape, AgentTokenError>> => {
  const result = await Result.tryPromise(
    async () =>
      await callOauth2Token({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: AGENT_REDIRECT_URI,
        resource: getMcpResourceUrl(resourceMode),
      }),
  );

  if (Result.isError(result) || !isTokenResponse(result.value)) {
    return Result.err(new AgentTokenError("token_mint_failed"));
  }
  return Result.ok(reshapeTokenResponse(result.value));
};

/**
 * Mint an audience-bound JWT for an anonymous agent via the
 * client_credentials grant. The token carries anonymized scopes and the
 * anonymized resource audience but no `sub`/`org_id` (anonymous agents
 * have no org principal). It cannot widen to default scopes — the
 * client's scope allow-list rejects them — and so cannot reach the
 * member-scoped MCP surface until the agent is later claimed.
 */
const mintAnonymousToken = async (
  credentials: AgentClientCredentials,
): Promise<Result<TokenResponseShape, AgentTokenError>> => {
  const resource = getMcpResourceUrl("anonymized");
  const result = await Result.tryPromise(
    async () =>
      await callOauth2Token({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: AGENT_AUTH_ANONYMOUS_SCOPES.join(" "),
        resource,
      }),
  );

  if (Result.isError(result)) {
    return Result.err(new AgentTokenError("token_mint_failed"));
  }
  if (!isTokenResponse(result.value)) {
    return Result.err(new AgentTokenError("token_mint_failed"));
  }
  return Result.ok(reshapeTokenResponse(result.value));
};

export type AgentTokenErrorCode =
  | "authorization_pending"
  | "slow_down"
  | "expired_token"
  | "access_denied"
  | "invalid_grant"
  | "token_mint_failed";

export class AgentTokenError extends Error {
  readonly code: AgentTokenErrorCode;
  constructor(code: AgentTokenErrorCode) {
    super(code);
    this.code = code;
    this.name = "AgentTokenError";
  }
}

export type ServiceAuthCeremony = {
  registrationId: string;
  registrationType: "service_auth";
  userCode: string;
  claimToken: string;
  expiresIn: number;
  interval: number;
};

export type AnonymousRegistrationResult = {
  registrationId: string;
  registrationType: "anonymous";
  claimToken: string;
  token: TokenResponseShape;
};

/**
 * Start a service_auth ceremony: create the agent client + registration
 * row and return the RFC 8628-style device-claim parameters. The same
 * shape is returned whether or not `loginHint` maps to a real user, so a
 * caller cannot probe for account existence.
 */
export const startServiceAuthRegistration = async (
  loginHint: string | null,
): Promise<ServiceAuthCeremony> => {
  const registrationId = createSafeId<"mcpOAuthClient">();
  const claimToken = generateOpaqueToken();
  const userCode = generateUserCode();
  const credentials = await createAgentOAuthClient({
    registrationType: "service_auth",
    registrationId,
    scopes: AGENT_AUTH_SERVICE_SCOPES,
    grantTypes: ["authorization_code"],
  });
  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);

  await rootDb.insert(agentRegistration).values({
    id: registrationId,
    registrationType: "service_auth",
    status: "pending",
    userCode,
    claimTokenHash: hashClaimToken(claimToken),
    clientId: credentials.clientId,
    clientSecretSink: credentials.clientSecret,
    loginHint,
    grantedScopes: [...AGENT_AUTH_SERVICE_SCOPES],
    pollIntervalSeconds: AGENT_AUTH_POLL_INTERVAL_SECONDS,
    expiresAt,
  });

  return {
    registrationId,
    registrationType: "service_auth",
    userCode,
    claimToken,
    expiresIn: AGENT_AUTH_CEREMONY_TTL_SECONDS,
    interval: AGENT_AUTH_POLL_INTERVAL_SECONDS,
  };
};

/**
 * Register an anonymous agent: mint a reduced-scope token immediately
 * and persist a claimable registration so a user can upgrade it later.
 */
export const startAnonymousRegistration = async (): Promise<
  Result<AnonymousRegistrationResult, AgentTokenError>
> => {
  const registrationId = createSafeId<"mcpOAuthClient">();
  const claimToken = generateOpaqueToken();
  const credentials = await createAgentOAuthClient({
    registrationType: "anonymous",
    registrationId,
    scopes: AGENT_AUTH_ANONYMOUS_SCOPES,
    grantTypes: ["client_credentials"],
  });

  const tokenResult = await mintAnonymousToken(credentials);
  if (Result.isError(tokenResult)) {
    return Result.err(tokenResult.error);
  }

  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);
  await rootDb.insert(agentRegistration).values({
    id: registrationId,
    registrationType: "anonymous",
    status: "pending",
    claimTokenHash: hashClaimToken(claimToken),
    clientId: credentials.clientId,
    clientSecretSink: credentials.clientSecret,
    grantedScopes: [...AGENT_AUTH_ANONYMOUS_SCOPES],
    pollIntervalSeconds: AGENT_AUTH_POLL_INTERVAL_SECONDS,
    expiresAt,
  });

  return Result.ok({
    registrationId,
    registrationType: "anonymous",
    claimToken,
    token: tokenResult.value,
  });
};

type PendingRegistrationByCode = {
  id: string;
  registrationType: string;
  clientId: string;
  grantedScopes: string[];
  expiresAt: Date;
};

export type ConfirmRegistrationResult =
  | { status: "confirmed"; registrationId: string }
  | { status: "not_found" }
  | { status: "expired" };

/**
 * Bind a pending service_auth registration to the confirming human and
 * their active org, then drive better-auth's authorize endpoint with the
 * human's session to obtain an authorization code. The code's
 * `referenceId` becomes the org_id claim on the minted token. Persisting
 * the code flips the registration to `claimed`.
 */
export const confirmServiceAuthRegistration = async ({
  userCode,
  userId,
  organizationId,
  sessionCookieHeader,
}: {
  userCode: string;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  sessionCookieHeader: string;
}): Promise<ConfirmRegistrationResult> => {
  const rows = await rootDb
    .select({
      id: agentRegistration.id,
      registrationType: agentRegistration.registrationType,
      clientId: agentRegistration.clientId,
      grantedScopes: agentRegistration.grantedScopes,
      expiresAt: agentRegistration.expiresAt,
    })
    .from(agentRegistration)
    .where(
      and(
        eq(agentRegistration.userCode, userCode),
        eq(agentRegistration.status, "pending"),
      ),
    )
    .limit(1);

  const registration: PendingRegistrationByCode | undefined = rows.at(0);
  if (!registration) {
    return { status: "not_found" };
  }
  if (registration.expiresAt < new Date()) {
    await rootDb
      .update(agentRegistration)
      .set({ status: "expired" })
      .where(eq(agentRegistration.id, registration.id));
    return { status: "expired" };
  }

  const codeResult = await issueAuthorizationCode({
    clientId: registration.clientId,
    scopes: registration.grantedScopes,
    sessionCookieHeader,
  });
  if (Result.isError(codeResult)) {
    return { status: "not_found" };
  }

  await rootDb
    .update(agentRegistration)
    .set({
      status: "claimed",
      boundUserId: userId,
      boundOrganizationId: organizationId,
      authorizationCode: codeResult.value,
    })
    .where(eq(agentRegistration.id, registration.id));

  return { status: "confirmed", registrationId: registration.id };
};

export class AuthorizeCodeError extends Error {
  override name = "AuthorizeCodeError";
}

/** better-auth's session-token cookie name, mirroring its cookie getter. */
const getSessionCookieName = (): string => {
  if (env.isDev) {
    return `${env.BETTER_AUTH_COOKIE_PREFIX ?? "stella-dev"}.session_token`;
  }
  return "__Secure-better-auth.session_token";
};

/** How long an internally-minted agent session row stays valid. */
const INTERNAL_SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * Mint a short-lived server-side session for a resolved user + org and
 * return a `cookie` header better-auth will accept. Reuses the same
 * `{token}.{hmac}` scheme as the synthetic-monitor session: the
 * signature is HMAC-SHA256(token) base64-encoded, matching better-call's
 * cookie verification. Used by the ID-JAG path, which has a resolved
 * principal but no live browser session to drive the authorize flow.
 */
export const mintInternalSessionCookieHeader = async ({
  userId,
  organizationId,
}: {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
}): Promise<string> => {
  const now = new Date();
  const token = `${Bun.randomUUIDv7()}${Bun.randomUUIDv7()}`.replaceAll(
    "-",
    "",
  );
  await rootDb.insert(session).values({
    id: `agent-idjag-${token}`,
    token,
    userId,
    activeOrganizationId: organizationId,
    expiresAt: new Date(now.getTime() + INTERNAL_SESSION_TTL_MS),
    createdAt: now,
    updatedAt: now,
    ipAddress: "agent-idjag",
    userAgent: "stella-agent-auth/id-jag",
  });

  const signature = new Bun.CryptoHasher("sha256", env.BETTER_AUTH_SECRET)
    .update(token)
    .digest("base64");

  return `${getSessionCookieName()}=${token}.${signature}`;
};

/**
 * Drive the real `/oauth2/authorize` endpoint through the auth handler
 * (so `ctx.request` and the session cookie are present) and read the
 * authorization code from the redirect response. `accept: application/json`
 * makes better-auth return the redirect target as JSON instead of a 302.
 */
export const issueAuthorizationCode = async ({
  clientId,
  scopes,
  sessionCookieHeader,
}: {
  clientId: string;
  scopes: readonly string[];
  sessionCookieHeader: string;
}): Promise<Result<string, AuthorizeCodeError>> => {
  const authorizeUrl = new URL(getAuthEndpointUrl("oauth2/authorize"));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", AGENT_REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", scopes.join(" "));

  const responseResult = await Result.tryPromise(
    async () =>
      await getAuth().handler(
        new Request(authorizeUrl.toString(), {
          method: "GET",
          headers: {
            cookie: sessionCookieHeader,
            accept: "application/json",
          },
        }),
      ),
  );
  if (Result.isError(responseResult)) {
    return Result.err(new AuthorizeCodeError());
  }

  // Only parse a JSON body (the accept: application/json authorize response);
  // a plain 302 has a non-JSON body whose parse would throw needlessly.
  const contentType = responseResult.value.headers.get("content-type") ?? "";
  const bodyResult = contentType.includes("application/json")
    ? await Result.tryPromise(
        async (): Promise<unknown> => await responseResult.value.json(),
      )
    : Result.ok(null);
  const locationHeader = responseResult.value.headers.get("location");
  const redirectTarget = resolveRedirectTarget(
    Result.isOk(bodyResult) ? bodyResult.value : null,
    locationHeader,
  );
  if (!redirectTarget) {
    return Result.err(new AuthorizeCodeError());
  }

  const targetUrlResult = Result.try(() => new URL(redirectTarget));
  if (Result.isError(targetUrlResult)) {
    return Result.err(new AuthorizeCodeError());
  }
  const code = targetUrlResult.value.searchParams.get("code");
  if (!code) {
    return Result.err(new AuthorizeCodeError());
  }
  return Result.ok(code);
};

const hasStringUrl = (value: unknown): value is { url: string } =>
  typeof value === "object" &&
  value !== null &&
  "url" in value &&
  typeof value.url === "string";

const resolveRedirectTarget = (
  body: unknown,
  locationHeader: string | null,
): string | null => {
  if (hasStringUrl(body)) {
    return body.url;
  }
  return locationHeader;
};

type PendingPollRow = {
  id: string;
  registrationType: string;
  status: AgentRegistrationStatus;
  clientId: string;
  clientSecretSink: string;
  authorizationCode: string | null;
  expiresAt: Date;
  lastPolledAt: Date | null;
  pollIntervalSeconds: number;
};

/**
 * Process one claim-grant poll. Maps registration state to the RFC
 * 8628 error vocabulary, enforces the poll interval server-side, and on
 * a claimed registration exchanges the stored code one-shot for the
 * agent's scoped access token.
 */
export const pollClaimGrant = async (
  claimToken: string,
): Promise<Result<TokenResponseShape, AgentTokenError>> => {
  const tokenHash = hashClaimToken(claimToken);
  const rows = await rootDb
    .select({
      id: agentRegistration.id,
      registrationType: agentRegistration.registrationType,
      status: agentRegistration.status,
      clientId: agentRegistration.clientId,
      clientSecretSink: agentRegistration.clientSecretSink,
      authorizationCode: agentRegistration.authorizationCode,
      expiresAt: agentRegistration.expiresAt,
      lastPolledAt: agentRegistration.lastPolledAt,
      pollIntervalSeconds: agentRegistration.pollIntervalSeconds,
    })
    .from(agentRegistration)
    .where(eq(agentRegistration.claimTokenHash, tokenHash))
    .limit(1);

  const registration = narrowPollRow(rows.at(0));
  if (!registration) {
    return Result.err(new AgentTokenError("invalid_grant"));
  }

  const now = new Date();
  if (registration.status === "denied") {
    return Result.err(new AgentTokenError("access_denied"));
  }
  if (registration.status === "expired" || registration.expiresAt < now) {
    if (registration.status !== "expired") {
      await rootDb
        .update(agentRegistration)
        .set({ status: "expired" })
        .where(eq(agentRegistration.id, registration.id));
    }
    return Result.err(new AgentTokenError("expired_token"));
  }

  if (
    registration.lastPolledAt &&
    now.getTime() - registration.lastPolledAt.getTime() <
      registration.pollIntervalSeconds * 1000
  ) {
    return Result.err(new AgentTokenError("slow_down"));
  }

  await rootDb
    .update(agentRegistration)
    .set({ lastPolledAt: now })
    .where(eq(agentRegistration.id, registration.id));

  if (registration.status === "pending" || !registration.authorizationCode) {
    return Result.err(new AgentTokenError("authorization_pending"));
  }

  return await exchangeClaimedCode(registration);
};

const narrowPollRow = (
  row:
    | {
        id: string;
        registrationType: string;
        status: string;
        clientId: string;
        clientSecretSink: string;
        authorizationCode: string | null;
        expiresAt: Date;
        lastPolledAt: Date | null;
        pollIntervalSeconds: number;
      }
    | undefined,
): PendingPollRow | undefined => {
  if (!row) {
    return undefined;
  }
  if (!isRegistrationStatus(row.status)) {
    return undefined;
  }
  return { ...row, status: row.status };
};

const isRegistrationStatus = (
  value: string,
): value is AgentRegistrationStatus =>
  value === "pending" ||
  value === "claimed" ||
  value === "denied" ||
  value === "expired";

/**
 * Exchange the stored authorization code for a JWT bound to the MCP
 * resource (so it verifies via apps/api/src/mcp/auth.ts) and consume the
 * code one-shot: the registration row is cleared of the code regardless
 * of exchange outcome so a leaked claim token cannot replay it.
 */
const exchangeClaimedCode = async (
  registration: PendingPollRow,
): Promise<Result<TokenResponseShape, AgentTokenError>> => {
  const code = registration.authorizationCode;
  if (!code) {
    return Result.err(new AgentTokenError("invalid_grant"));
  }

  await rootDb
    .update(agentRegistration)
    .set({ authorizationCode: null })
    .where(eq(agentRegistration.id, registration.id));

  const resource = getMcpResourceUrl(
    getResourceModeForType(toRegistrationType(registration.registrationType)),
  );
  const result = await Result.tryPromise(
    async () =>
      await callOauth2Token({
        grant_type: "authorization_code",
        client_id: registration.clientId,
        client_secret: registration.clientSecretSink,
        code,
        redirect_uri: AGENT_REDIRECT_URI,
        resource,
      }),
  );

  if (Result.isError(result) || !isTokenResponse(result.value)) {
    return Result.err(new AgentTokenError("token_mint_failed"));
  }
  return Result.ok(reshapeTokenResponse(result.value));
};

const toRegistrationType = (value: string): AgentRegistrationType =>
  value === "anonymous" ? "anonymous" : "service_auth";

/**
 * Start an email-bound claim ceremony for an already-issued anonymous
 * registration. Promotes the anonymous registration to a service_auth
 * ceremony: a fresh user_code + claim token a user completes by signing
 * in. Identical response whether or not `email` resolves to a user.
 */
export const startAnonymousUpgrade = async ({
  claimToken,
  email,
}: {
  claimToken: string;
  email: string;
}): Promise<Result<ServiceAuthCeremony, AgentTokenError>> => {
  const tokenHash = hashClaimToken(claimToken);
  const rows = await rootDb
    .select({
      id: agentRegistration.id,
      registrationType: agentRegistration.registrationType,
      status: agentRegistration.status,
      expiresAt: agentRegistration.expiresAt,
    })
    .from(agentRegistration)
    .where(eq(agentRegistration.claimTokenHash, tokenHash))
    .limit(1);

  const registration = rows.at(0);
  if (
    !registration ||
    registration.registrationType !== "anonymous" ||
    registration.status !== "pending" ||
    registration.expiresAt < new Date()
  ) {
    return Result.err(new AgentTokenError("invalid_grant"));
  }

  // The original anonymous client only holds client_credentials; a claim
  // needs an authorization_code client. Issue a fresh service_auth
  // ceremony and bind the new claim token, leaving the anonymous row's
  // existing token valid until the user completes the upgrade.
  const newClaimToken = generateOpaqueToken();
  const userCode = generateUserCode();
  const credentials = await createAgentOAuthClient({
    registrationType: "service_auth",
    registrationId: registration.id,
    scopes: AGENT_AUTH_SERVICE_SCOPES,
    grantTypes: ["authorization_code"],
  });
  const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);

  await rootDb
    .update(agentRegistration)
    .set({
      registrationType: "service_auth",
      userCode,
      claimTokenHash: hashClaimToken(newClaimToken),
      clientId: credentials.clientId,
      clientSecretSink: credentials.clientSecret,
      loginHint: email,
      grantedScopes: [...AGENT_AUTH_SERVICE_SCOPES],
      expiresAt,
      lastPolledAt: null,
    })
    .where(eq(agentRegistration.id, registration.id));

  return Result.ok({
    registrationId: registration.id,
    registrationType: "service_auth",
    userCode,
    claimToken: newClaimToken,
    expiresIn: AGENT_AUTH_CEREMONY_TTL_SECONDS,
    interval: AGENT_AUTH_POLL_INTERVAL_SECONDS,
  });
};
