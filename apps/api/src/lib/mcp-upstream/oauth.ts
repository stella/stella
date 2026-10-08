import { Result, TaggedError } from "better-result";
import { getDomain } from "tldts";
import * as v from "valibot";

import { withTimeout, TimeoutError } from "@stll/concurrency/with-timeout";
import { Temporal } from "@stll/time";

import type { McpOAuthRegistrationResponse } from "@/api/db/schema";
import { env } from "@/api/env";
import { arrayOrEmpty } from "@/api/lib/array";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  FetchBoundaryError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
import { redactMcpOAuthRegistrationResponse } from "@/api/lib/mcp-upstream/oauth-registration-response";
import {
  authorizationServerMetadataUrls,
  mcpResourceMatchesConnector,
  mcpWellKnownProtectedResourceUrls,
} from "@/api/lib/mcp-upstream/url-safety";
import {
  safeOutboundFetchBytes,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";
import type {
  SafeOutboundFetchBody,
  SafeOutboundHeaders,
} from "@/api/lib/safe-outbound-fetch";
import type { ClientSecret, RefreshToken } from "@/api/lib/secret-brands";

const OAUTH_FETCH_TIMEOUT_MS = 10_000;
export const MCP_OAUTH_BINDING_FAILURE_CODE = "mcp_oauth_binding_invalid";
export const MCP_OAUTH_INVALID_GRANT_CODE = "mcp_oauth_invalid_grant";
export const MCP_OAUTH_DISCOVERY_TIMEOUT_CODE = "mcp_oauth_discovery_timeout";
const OAUTH_FETCH_MAX_BYTES = 1_000_000;
const PKCE_VERIFIER_BYTES = 48;

class McpDiscoveryError extends TaggedError("McpDiscoveryError")<{
  message: string;
  cause?: unknown;
}> {}

const protectedResourceMetadataSchema = v.looseObject({
  resource: v.pipe(v.string(), v.url()),
  authorization_servers: v.pipe(
    v.array(v.pipe(v.string(), v.url())),
    v.minLength(1),
  ),
  scopes_supported: v.optional(v.array(v.string())),
});

const authorizationServerMetadataSchema = v.looseObject({
  issuer: v.pipe(v.string(), v.url()),
  authorization_endpoint: v.pipe(v.string(), v.url()),
  token_endpoint: v.pipe(v.string(), v.url()),
  registration_endpoint: v.optional(v.pipe(v.string(), v.url())),
  scopes_supported: v.optional(v.array(v.string())),
  code_challenge_methods_supported: v.optional(v.array(v.string())),
  token_endpoint_auth_methods_supported: v.optional(v.array(v.string())),
  grant_types_supported: v.optional(v.array(v.string())),
  client_id_metadata_document_supported: v.optional(v.boolean()),
  authorization_response_iss_parameter_supported: v.optional(v.boolean()),
});

const dynamicClientRegistrationResponseSchema = v.looseObject({
  client_id: v.string(),
  client_secret: v.optional(v.string()),
});

const tokenResponseSchema = v.looseObject({
  access_token: v.string(),
  refresh_token: v.optional(v.string()),
  token_type: v.optional(v.string()),
  expires_in: v.optional(v.number()),
  scope: v.optional(v.string()),
});

export type ProtectedResourceMetadata = v.InferOutput<
  typeof protectedResourceMetadataSchema
>;

export type UpstreamAuthorizationServerMetadata = v.InferOutput<
  typeof authorizationServerMetadataSchema
>;

const boundOAuthMetadata = Symbol("BoundOAuthMetadata");

export type DiscoveredOAuthMetadata = {
  readonly authorizationServer: Readonly<UpstreamAuthorizationServerMetadata>;
  readonly protectedResource: Readonly<ProtectedResourceMetadata>;
};

export type BoundOAuthMetadata = DiscoveredOAuthMetadata & {
  readonly [boundOAuthMetadata]: true;
};

/**
 * The authorization server a connector may use in an organization. An
 * `unconfigured` connector has no issuer an administrator or the curated
 * catalogue approved, so its observed issuer awaits administrator review.
 */
export type McpIssuerBinding =
  | {
      type: "approved";
      issuer: string;
      endpointOrigins: readonly string[];
    }
  | { type: "unconfigured" };

export type ApprovedMcpIssuerBinding = Extract<
  McpIssuerBinding,
  { type: "approved" }
>;

export const mcpAuthorizationApprovalRequiredError = () =>
  new HandlerError({
    status: 409,
    code: "mcp_authorization_approval_required",
    message:
      "An administrator must approve this connector before you can connect.",
  });

export const oauthDomainsMatch = (
  firstUrl: string,
  secondUrl: string,
): boolean => {
  const first = new URL(firstUrl);
  const second = new URL(secondUrl);
  const firstDomain = getDomain(first.hostname, { allowPrivateDomains: true });
  const secondDomain = getDomain(second.hostname, {
    allowPrivateDomains: true,
  });
  return firstDomain !== null && secondDomain !== null
    ? firstDomain === secondDomain
    : first.origin === second.origin;
};

export const getOAuthEndpointOrigins = ({
  authorizationServer,
}: DiscoveredOAuthMetadata): string[] => [
  ...new Set(
    [
      authorizationServer.authorization_endpoint,
      authorizationServer.token_endpoint,
      authorizationServer.registration_endpoint,
    ]
      .filter((url) => url !== undefined)
      .map((url) => new URL(url).origin),
  ),
];

export const endpointsRequiringConfirmation = (
  metadata: DiscoveredOAuthMetadata,
): string[] =>
  getOAuthEndpointOrigins(metadata).filter(
    (origin) => !oauthDomainsMatch(metadata.authorizationServer.issuer, origin),
  );

type BindDiscoveredMetadataOptions = {
  connectorUrl: string;
  protectedResource: ProtectedResourceMetadata;
  authorizationServer: UpstreamAuthorizationServerMetadata;
  confirmedEndpointOrigins?: readonly string[];
};

export const bindDiscoveredMetadata = ({
  connectorUrl,
  protectedResource,
  authorizationServer,
  confirmedEndpointOrigins = [],
}: BindDiscoveredMetadataOptions): Result<
  BoundOAuthMetadata,
  HandlerError<409 | 502>
> => {
  const resource = validateResourceBinding(
    connectorUrl,
    protectedResource.resource,
  );
  if (Result.isError(resource)) {
    return Result.err(resource.error);
  }
  if (
    authorizationServer.issuer !== protectedResource.authorization_servers.at(0)
  ) {
    return Result.err(
      new HandlerError({
        status: 502,
        code: MCP_OAUTH_BINDING_FAILURE_CODE,
        message:
          "MCP authorization server metadata does not match the selected issuer",
      }),
    );
  }
  if (
    endpointsRequiringConfirmation({
      authorizationServer,
      protectedResource,
    }).some((origin) => !confirmedEndpointOrigins.includes(origin))
  ) {
    return Result.err(mcpAuthorizationApprovalRequiredError());
  }
  return Result.ok({
    [boundOAuthMetadata]: true,
    authorizationServer: Object.freeze({ ...authorizationServer }),
    protectedResource: Object.freeze({ ...protectedResource }),
  });
};

const validateResourceBinding = (
  connectorUrl: string,
  resourceUrl: string,
): Result<void, HandlerError<502>> => {
  const matches = Result.try(() =>
    mcpResourceMatchesConnector({ connectorUrl, resourceUrl }),
  );
  if (Result.isError(matches) || !matches.value) {
    return Result.err(
      new HandlerError({
        status: 502,
        code: MCP_OAUTH_BINDING_FAILURE_CODE,
        message: "MCP resource metadata does not match the connector URL",
      }),
    );
  }
  return Result.ok(undefined);
};

export const validateApprovedOAuthIssuer = (
  metadata: DiscoveredOAuthMetadata,
  binding: ApprovedMcpIssuerBinding,
): Result<void, HandlerError<409>> =>
  metadata.authorizationServer.issuer === binding.issuer
    ? Result.ok(undefined)
    : Result.err(mcpAuthorizationApprovalRequiredError());

type OAuthDiscoveryDependencies = {
  permit: ThirdPartyOutboundPermit;
  signal?: AbortSignal;
  timeoutMs?: number;
  safeOutboundFetchBytes: typeof safeOutboundFetchBytes;
  validateOutboundFetchTarget: typeof validateOutboundFetchTarget;
};

type OAuthDependencyOverrides = Omit<OAuthDiscoveryDependencies, "permit">;

const DEFAULT_OAUTH_DISCOVERY_DEPENDENCIES: OAuthDependencyOverrides = {
  safeOutboundFetchBytes,
  validateOutboundFetchTarget,
};

export type TokenResponse = v.InferOutput<typeof tokenResponseSchema>;

export type RegisteredOAuthClient = {
  clientId: string;
  clientSecret: string | null;
  registrationResponse: McpOAuthRegistrationResponse;
};

type McpFetchJsonInit = {
  body?: SafeOutboundFetchBody | undefined;
  headers?: SafeOutboundHeaders | undefined;
  method?: string | undefined;
};

const fetchJson = async <T>({
  init,
  schema,
  url,
  dependencies,
}: {
  dependencies: OAuthDiscoveryDependencies;
  init?: McpFetchJsonInit | undefined;
  schema: v.GenericSchema<unknown, T>;
  url: URL;
}): Promise<Result<T, McpDiscoveryError>> =>
  await Result.tryPromise({
    try: async () => {
      dependencies.signal?.throwIfAborted();
      const headers = new Headers(init?.headers);
      if (!headers.has("Accept")) {
        headers.set("Accept", "application/json");
      }

      const response = await dependencies.safeOutboundFetchBytes({
        body: init?.body,
        headers,
        maxBytes: OAUTH_FETCH_MAX_BYTES,
        method: init?.method,
        permit: dependencies.permit,
        timeoutMs: dependencies.timeoutMs ?? OAUTH_FETCH_TIMEOUT_MS,
        signal: dependencies.signal,
        url,
      });
      if (Result.isError(response)) {
        throw response.error;
      }

      if (!response.value.ok) {
        const body = new TextDecoder().decode(response.value.body);
        throw new FetchBoundaryError({
          url: url.toString(),
          status: response.value.status,
          ...(body.length > 0 ? { body: body.slice(0, 500) } : {}),
          message:
            body.length > 0
              ? `HTTP ${response.value.status}: ${body.slice(0, 500)}`
              : `HTTP ${response.value.status}`,
        });
      }

      return v.parse(
        schema,
        JSON.parse(new TextDecoder().decode(response.value.body)),
      );
    },
    catch: (cause) =>
      new McpDiscoveryError({
        message: `Failed to fetch ${url.toString()}`,
        cause,
      }),
  });

type DiscoverOAuthMetadataOptions = {
  rawMcpUrl: string;
  permit: ThirdPartyOutboundPermit;
  dependencies?: OAuthDependencyOverrides;
  confirmedEndpointOrigins?: readonly string[];
};

export const discoverOAuthMetadata = async ({
  rawMcpUrl,
  permit,
  dependencies = DEFAULT_OAUTH_DISCOVERY_DEPENDENCIES,
  confirmedEndpointOrigins = [],
}: DiscoverOAuthMetadataOptions): Promise<
  Result<BoundOAuthMetadata, HandlerError<400 | 409 | 502>>
> => {
  const discovered = await discoverOAuthMetadataForApproval({
    rawMcpUrl,
    permit,
    dependencies,
  });
  if (Result.isError(discovered)) {
    return Result.err(discovered.error);
  }
  return bindDiscoveredMetadata({
    connectorUrl: rawMcpUrl,
    ...discovered.value,
    confirmedEndpointOrigins,
  });
};

type DiscoverOAuthMetadataForApprovalOptions = {
  rawMcpUrl: string;
  permit: ThirdPartyOutboundPermit;
  dependencies?: OAuthDependencyOverrides;
};

export const discoverOAuthMetadataForApproval = async ({
  rawMcpUrl,
  permit,
  dependencies = DEFAULT_OAUTH_DISCOVERY_DEPENDENCIES,
}: DiscoverOAuthMetadataForApprovalOptions): Promise<
  Result<DiscoveredOAuthMetadata, HandlerError<400 | 502>>
> => {
  const requestDependencies = { ...dependencies, permit };
  const result = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async (signal) =>
          await discoverOAuthMetadataWithinDeadline(rawMcpUrl, {
            ...requestDependencies,
            signal,
          }),
        {
          label: "MCP OAuth discovery",
          timeoutMs: requestDependencies.timeoutMs ?? OAUTH_FETCH_TIMEOUT_MS,
        },
      ),
    catch: (cause) =>
      new HandlerError({
        status: 502,
        code: TimeoutError.is(cause)
          ? MCP_OAUTH_DISCOVERY_TIMEOUT_CODE
          : "mcp_oauth_discovery_failed",
        message: "MCP OAuth metadata discovery did not complete",
        cause,
      }),
  });
  return Result.isError(result) ? Result.err(result.error) : result.value;
};

const discoverOAuthMetadataWithinDeadline = async (
  rawMcpUrl: string,
  dependencies: OAuthDiscoveryDependencies,
): Promise<Result<DiscoveredOAuthMetadata, HandlerError<400 | 502>>> => {
  const target = await dependencies.validateOutboundFetchTarget(rawMcpUrl);
  if (Result.isError(target)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: target.error.message,
        cause: target.error,
      }),
    );
  }
  const parsedUrl = target.value.url;

  let protectedResource: ProtectedResourceMetadata | null = null;
  for (const metadataUrl of mcpWellKnownProtectedResourceUrls(parsedUrl)) {
    const result = await fetchJson({
      dependencies,
      schema: protectedResourceMetadataSchema,
      url: metadataUrl,
    });
    if (Result.isOk(result)) {
      protectedResource = result.value;
      break;
    }
  }

  if (!protectedResource) {
    return Result.err(
      new HandlerError({
        status: 502,
        message: "MCP server did not expose protected resource metadata",
      }),
    );
  }

  const resource = validateResourceBinding(
    rawMcpUrl,
    protectedResource.resource,
  );
  if (Result.isError(resource)) {
    return Result.err(resource.error);
  }
  const authorizationServerUrl = protectedResource.authorization_servers.at(0);
  if (!authorizationServerUrl) {
    return Result.err(
      new HandlerError({
        status: 502,
        message: "MCP authorization server metadata could not be discovered",
      }),
    );
  }
  const authorizationServer = await discoverAuthorizationServer(
    authorizationServerUrl,
    dependencies,
  );
  if (Result.isError(authorizationServer)) {
    return Result.err(authorizationServer.error);
  }
  return Result.ok({
    protectedResource,
    authorizationServer: authorizationServer.value,
  });
};

const randomBase64Url = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
};

export const createPkce = () => {
  const codeVerifier = randomBase64Url(PKCE_VERIFIER_BYTES);
  const codeChallenge = new Bun.CryptoHasher("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeChallenge, codeVerifier };
};

export const createOAuthState = (): string => randomBase64Url(32);

export const getMcpOAuthRedirectUri = (): string => {
  const publicUrl = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;
  return new URL("/v1/mcp/oauth/callback", publicUrl).toString();
};

export type McpClientRegistrationMode = "cimd" | "dcr" | "unsupported";

// Client ID Metadata Documents are the MCP spec's preferred registration
// mechanism; Dynamic Client Registration is retained for authorization
// servers that have not adopted CIMD yet.
export const clientRegistrationMode = (
  authorizationServer: UpstreamAuthorizationServerMetadata,
): McpClientRegistrationMode => {
  if (authorizationServer.client_id_metadata_document_supported === true) {
    return "cimd";
  }
  if (authorizationServer.registration_endpoint) {
    return "dcr";
  }
  return "unsupported";
};

const MCP_CLIENT_METADATA_DOCUMENT_PATH = "/v1/mcp/oauth/client-metadata.json";

export const getMcpClientMetadataDocumentUrl = (): string => {
  const publicUrl = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;
  return new URL(MCP_CLIENT_METADATA_DOCUMENT_PATH, publicUrl).toString();
};

export type McpClientMetadataDocument = {
  client_id: string;
  client_name: string;
  client_uri: string;
  grant_types: string[];
  redirect_uris: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
};

// draft-ietf-oauth-client-id-metadata-document: the document's `client_id`
// must equal the URL it is served from, and it must not carry any shared
// secret (stella is a public client; PKCE protects the code exchange).
export const buildMcpClientMetadataDocument =
  (): McpClientMetadataDocument => ({
    client_id: getMcpClientMetadataDocumentUrl(),
    client_name: "stella",
    client_uri: env.FRONTEND_URL,
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [getMcpOAuthRedirectUri()],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });

export const buildAuthorizeUrl = ({
  metadata,
  clientId,
  codeChallenge,
  connectorSlug,
  redirectUri,
  requestedScopes,
  state,
}: {
  metadata: BoundOAuthMetadata;
  clientId: string;
  codeChallenge: string;
  connectorSlug: string;
  redirectUri: string;
  requestedScopes: string[];
  state: string;
}): string => {
  const url = new URL(metadata.authorizationServer.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", metadata.protectedResource.resource);

  if (requestedScopes.length > 0) {
    url.searchParams.set("scope", requestedScopes.join(" "));
  }

  url.searchParams.set("stella_connector", connectorSlug);

  return url.toString();
};

export type OAuthClientRegistrationRequest = {
  client_name: string;
  client_uri: string;
  grant_types: string[];
  redirect_uris: string[];
  response_types: string[];
  scope?: string;
  software_id: string;
  token_endpoint_auth_method: "none";
};

/**
 * The RFC 7591 registration body stella posts when it is the client.
 *
 * Exported so the registration census in
 * `tests/helpers/oauth-client-registration-fixtures.ts` builds the body from this
 * producer rather than carrying a copy, which would keep asserting a shape
 * stella had stopped sending.
 *
 * `contacts` is optional (RFC 7591 §2) and some authorization servers reject
 * an empty array as invalid metadata, so it is omitted rather than sent empty.
 */
export const buildOAuthClientRegistrationRequest = ({
  clientUri,
  connectorSlug,
  redirectUri,
  requestedScopes,
}: {
  clientUri: string;
  connectorSlug: string;
  redirectUri: string;
  requestedScopes: string[];
}): OAuthClientRegistrationRequest => ({
  client_name: "stella",
  client_uri: clientUri,
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: [redirectUri],
  response_types: ["code"],
  software_id: `stella-${connectorSlug}`,
  token_endpoint_auth_method: "none",
  ...(requestedScopes.length > 0 ? { scope: requestedScopes.join(" ") } : {}),
});

export const registerOAuthClient = async ({
  metadata,
  permit,
  dependencies = DEFAULT_OAUTH_DISCOVERY_DEPENDENCIES,
  connectorSlug,
  redirectUri,
  requestedScopes,
}: {
  metadata: BoundOAuthMetadata;
  permit: ThirdPartyOutboundPermit;
  dependencies?: OAuthDependencyOverrides;
  connectorSlug: string;
  redirectUri: string;
  requestedScopes: string[];
}): Promise<Result<RegisteredOAuthClient, HandlerError<502>>> => {
  const { authorizationServer } = metadata;
  if (!authorizationServer.registration_endpoint) {
    return Result.err(
      new HandlerError({
        status: 502,
        message:
          "MCP authorization server does not support dynamic registration",
      }),
    );
  }

  const registrationBody = buildOAuthClientRegistrationRequest({
    clientUri: env.FRONTEND_URL,
    connectorSlug,
    redirectUri,
    requestedScopes,
  });

  const response = await fetchJson({
    dependencies: { ...dependencies, permit },
    init: {
      body: JSON.stringify(registrationBody),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
    schema: dynamicClientRegistrationResponseSchema,
    url: new URL(authorizationServer.registration_endpoint),
  });

  if (Result.isError(response)) {
    return Result.err(
      new HandlerError({
        status: 502,
        message: "Failed to register stella with MCP authorization server",
        cause: response.error,
      }),
    );
  }

  return Result.ok({
    clientId: response.value.client_id,
    clientSecret: response.value.client_secret ?? null,
    registrationResponse: redactMcpOAuthRegistrationResponse(response.value),
  });
};

export const exchangeAuthorizationCode = async ({
  metadata,
  permit,
  dependencies = DEFAULT_OAUTH_DISCOVERY_DEPENDENCIES,
  clientId,
  clientSecret,
  code,
  codeVerifier,
  responseIssuer,
  redirectUri,
}: {
  metadata: BoundOAuthMetadata;
  permit: ThirdPartyOutboundPermit;
  dependencies?: OAuthDependencyOverrides;
  clientId: string;
  clientSecret: ClientSecret | null;
  code: string;
  codeVerifier: string;
  responseIssuer: string | undefined;
  redirectUri: string;
}): Promise<Result<TokenResponse, HandlerError<502>>> => {
  if (
    (responseIssuer !== undefined ||
      metadata.authorizationServer
        .authorization_response_iss_parameter_supported === true) &&
    responseIssuer !== metadata.authorizationServer.issuer
  ) {
    return Result.err(
      new HandlerError({
        status: 502,
        message: "MCP authorization response issuer does not match",
      }),
    );
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    resource: metadata.protectedResource.resource,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const token = await fetchJson({
    dependencies: { ...dependencies, permit },
    init: {
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    },
    schema: tokenResponseSchema,
    url: new URL(metadata.authorizationServer.token_endpoint),
  });

  if (Result.isError(token)) {
    return Result.err(
      new HandlerError({
        status: 502,
        message: "Failed to exchange MCP authorization code",
        cause: token.error,
      }),
    );
  }

  return Result.ok(token.value);
};

export const refreshOAuthToken = async ({
  metadata,
  permit,
  dependencies = DEFAULT_OAUTH_DISCOVERY_DEPENDENCIES,
  clientId,
  clientSecret,
  refreshToken,
}: {
  metadata: BoundOAuthMetadata;
  permit: ThirdPartyOutboundPermit;
  dependencies?: OAuthDependencyOverrides;
  clientId: string;
  clientSecret: ClientSecret | null;
  refreshToken: RefreshToken;
}): Promise<Result<TokenResponse, HandlerError<502>>> => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource: metadata.protectedResource.resource,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const token = await fetchJson({
    dependencies: { ...dependencies, permit },
    init: {
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    },
    schema: tokenResponseSchema,
    url: new URL(metadata.authorizationServer.token_endpoint),
  });

  if (Result.isError(token)) {
    const cause = token.error.cause;
    const errorBody =
      cause instanceof FetchBoundaryError && cause.status === 400
        ? cause.body
        : undefined;
    const oauthError =
      errorBody === undefined || errorBody.length === 0
        ? null
        : Result.try(() =>
            v.parse(v.object({ error: v.string() }), JSON.parse(errorBody)),
          );
    return Result.err(
      new HandlerError({
        status: 502,
        ...(oauthError !== null &&
        Result.isOk(oauthError) &&
        oauthError.value.error === "invalid_grant"
          ? { code: MCP_OAUTH_INVALID_GRANT_CODE }
          : {}),
        message: "Failed to refresh MCP access token",
        cause: token.error,
      }),
    );
  }

  return Result.ok(token.value);
};

const discoverAuthorizationServer = async (
  authorizationServerUrl: string,
  dependencies: OAuthDiscoveryDependencies,
): Promise<Result<UpstreamAuthorizationServerMetadata, HandlerError<502>>> => {
  for (const metadataUrl of authorizationServerMetadataUrls(
    new URL(authorizationServerUrl),
  )) {
    const result = await fetchJson({
      dependencies,
      schema: authorizationServerMetadataSchema,
      url: metadataUrl,
    });
    if (Result.isOk(result)) {
      if (result.value.issuer !== authorizationServerUrl) {
        return Result.err(
          new HandlerError({
            status: 502,
            code: MCP_OAUTH_BINDING_FAILURE_CODE,
            message:
              "MCP authorization server metadata does not match the selected issuer",
          }),
        );
      }
      const safeMetadata = await validateAuthorizationServerMetadata(
        result.value,
        dependencies,
      );
      if (Result.isError(safeMetadata)) {
        return Result.err(safeMetadata.error);
      }
      return Result.ok(result.value);
    }
  }

  return Result.err(
    new HandlerError({
      status: 502,
      message: "MCP authorization server metadata could not be discovered",
    }),
  );
};

const validateAuthorizationServerMetadata = async (
  metadata: UpstreamAuthorizationServerMetadata,
  dependencies: OAuthDiscoveryDependencies,
): Promise<Result<void, HandlerError<502>>> => {
  const urls = [
    metadata.issuer,
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ].filter((url) => url !== undefined);

  // At most four endpoints, each validated independently: resolve them in one
  // round instead of paying a DNS round-trip per URL. The first unsafe URL
  // still decides the result.
  const validations = await Promise.all(
    urls.map(
      async (url) => await dependencies.validateOutboundFetchTarget(url),
    ),
  );
  for (const validation of validations) {
    if (Result.isError(validation)) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "MCP authorization server metadata contains an unsafe URL",
          cause: validation.error,
        }),
      );
    }
  }

  return Result.ok(undefined);
};

export const tokenExpiresAt = (token: TokenResponse): Date | null => {
  if (token.expires_in === undefined || token.expires_in <= 0) {
    return null;
  }

  return new Date(
    Temporal.Now.instant().epochMilliseconds + token.expires_in * 1000,
  );
};

export const pickRequestedScopes = ({
  connectorScopes,
  protectedResource,
}: {
  connectorScopes: string[] | null;
  protectedResource: ProtectedResourceMetadata;
}): string[] => {
  if (connectorScopes && connectorScopes.length > 0) {
    return connectorScopes;
  }

  return arrayOrEmpty(protectedResource.scopes_supported);
};

export const assertOAuthConnector = ({
  authType,
}: {
  authType: string;
}): Result<void, HandlerError<400>> => {
  if (authType === "oauth2") {
    return Result.ok(undefined);
  }

  return Result.err(
    new HandlerError({
      status: 400,
      message: "MCP connector does not use OAuth",
    }),
  );
};
