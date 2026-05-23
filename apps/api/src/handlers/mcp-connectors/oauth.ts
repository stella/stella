import { Result, TaggedError } from "better-result";
import { createHash, randomBytes } from "node:crypto";
import * as v from "valibot";

import type { McpOAuthRegistrationResponse } from "@/api/db/schema";
import { env } from "@/api/env";
import { redactMcpOAuthRegistrationResponse } from "@/api/handlers/mcp-connectors/oauth-registration-response";
import {
  authorizationServerMetadataUrls,
  mcpWellKnownProtectedResourceUrls,
} from "@/api/handlers/mcp-connectors/url-safety";
import {
  FetchBoundaryError,
  HandlerError,
} from "@/api/lib/errors/tagged-errors";
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
const OAUTH_FETCH_MAX_BYTES = 1_000_000;
const PKCE_VERIFIER_BYTES = 48;

class McpDiscoveryError extends TaggedError("McpDiscoveryError")<{
  message: string;
  cause?: unknown;
}>() {}

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
});

const dynamicClientRegistrationResponseSchema = v.intersect([
  v.object({
    client_id: v.string(),
  }),
  v.looseObject({
    client_secret: v.optional(v.string()),
  }),
]);

const tokenResponseSchema = v.intersect([
  v.object({
    access_token: v.string(),
  }),
  v.looseObject({
    refresh_token: v.optional(v.string()),
    token_type: v.optional(v.string()),
    expires_in: v.optional(v.number()),
    scope: v.optional(v.string()),
  }),
]);

export type ProtectedResourceMetadata = v.InferOutput<
  typeof protectedResourceMetadataSchema
>;

export type AuthorizationServerMetadata = v.InferOutput<
  typeof authorizationServerMetadataSchema
>;

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
}: {
  init?: McpFetchJsonInit | undefined;
  schema: v.GenericSchema<unknown, T>;
  url: URL;
}): Promise<Result<T, McpDiscoveryError>> =>
  await Result.tryPromise({
    try: async () => {
      const headers = new Headers(init?.headers);
      if (!headers.has("Accept")) {
        headers.set("Accept", "application/json");
      }

      const response = await safeOutboundFetchBytes({
        body: init?.body,
        headers,
        maxBytes: OAUTH_FETCH_MAX_BYTES,
        method: init?.method,
        timeoutMs: OAUTH_FETCH_TIMEOUT_MS,
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

export const discoverOAuthMetadata = async (
  rawMcpUrl: string,
): Promise<
  Result<
    {
      authorizationServer: AuthorizationServerMetadata;
      protectedResource: ProtectedResourceMetadata;
    },
    HandlerError<400 | 502>
  >
> => {
  const target = await validateOutboundFetchTarget(rawMcpUrl);
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

  const authorizationServerUrl = new URL(
    protectedResource.authorization_servers.at(0) ?? "",
  );
  let authorizationServer: AuthorizationServerMetadata | null = null;
  for (const metadataUrl of authorizationServerMetadataUrls(
    authorizationServerUrl,
  )) {
    const result = await fetchJson({
      schema: authorizationServerMetadataSchema,
      url: metadataUrl,
    });
    if (Result.isOk(result)) {
      const safeMetadata = await validateAuthorizationServerMetadata(
        result.value,
      );
      if (Result.isError(safeMetadata)) {
        return Result.err(safeMetadata.error);
      }
      authorizationServer = result.value;
      break;
    }
  }

  if (!authorizationServer) {
    return Result.err(
      new HandlerError({
        status: 502,
        message: "MCP authorization server metadata could not be discovered",
      }),
    );
  }

  return Result.ok({ authorizationServer, protectedResource });
};

export const createPkce = () => {
  const codeVerifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeChallenge, codeVerifier };
};

export const createOAuthState = (): string =>
  randomBytes(32).toString("base64url");

export const getMcpOAuthRedirectUri = (): string => {
  const publicUrl = env.PUBLIC_URL ?? env.BETTER_AUTH_URL;
  return new URL("/v1/mcp/oauth/callback", publicUrl).toString();
};

export const buildAuthorizeUrl = ({
  authorizationServer,
  clientId,
  codeChallenge,
  connectorSlug,
  protectedResource,
  redirectUri,
  requestedScopes,
  state,
}: {
  authorizationServer: AuthorizationServerMetadata;
  clientId: string;
  codeChallenge: string;
  connectorSlug: string;
  protectedResource: ProtectedResourceMetadata;
  redirectUri: string;
  requestedScopes: string[];
  state: string;
}): string => {
  const url = new URL(authorizationServer.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("resource", protectedResource.resource);

  if (requestedScopes.length > 0) {
    url.searchParams.set("scope", requestedScopes.join(" "));
  }

  url.searchParams.set("stella_connector", connectorSlug);

  return url.toString();
};

export const registerOAuthClient = async ({
  authorizationServer,
  connectorSlug,
  redirectUri,
  requestedScopes,
}: {
  authorizationServer: AuthorizationServerMetadata;
  connectorSlug: string;
  redirectUri: string;
  requestedScopes: string[];
}): Promise<Result<RegisteredOAuthClient, HandlerError<502>>> => {
  if (!authorizationServer.registration_endpoint) {
    return Result.err(
      new HandlerError({
        status: 502,
        message:
          "MCP authorization server does not support dynamic registration",
      }),
    );
  }

  const registrationBody = {
    client_name: "Stella",
    client_uri: env.FRONTEND_URL,
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [redirectUri],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    contacts: [],
    software_id: `stella-${connectorSlug}`,
    ...(requestedScopes.length > 0 ? { scope: requestedScopes.join(" ") } : {}),
  };

  const response = await fetchJson({
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
        message: "Failed to register Stella with MCP authorization server",
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
  authorizationServerUrl,
  clientId,
  clientSecret,
  code,
  codeVerifier,
  redirectUri,
  resourceUrl,
}: {
  authorizationServerUrl: string;
  clientId: string;
  clientSecret: ClientSecret | null;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  resourceUrl: string;
}): Promise<Result<TokenResponse, HandlerError<502>>> => {
  const metadata = await discoverAuthorizationServer(authorizationServerUrl);
  if (Result.isError(metadata)) {
    return Result.err(metadata.error);
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    resource: resourceUrl,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const token = await fetchJson({
    init: {
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    },
    schema: tokenResponseSchema,
    url: new URL(metadata.value.token_endpoint),
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
  authorizationServerUrl,
  clientId,
  clientSecret,
  refreshToken,
  resourceUrl,
}: {
  authorizationServerUrl: string;
  clientId: string;
  clientSecret: ClientSecret | null;
  refreshToken: RefreshToken;
  resourceUrl: string;
}): Promise<Result<TokenResponse, HandlerError<502>>> => {
  const metadata = await discoverAuthorizationServer(authorizationServerUrl);
  if (Result.isError(metadata)) {
    return Result.err(metadata.error);
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    resource: resourceUrl,
  });

  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const token = await fetchJson({
    init: {
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    },
    schema: tokenResponseSchema,
    url: new URL(metadata.value.token_endpoint),
  });

  if (Result.isError(token)) {
    return Result.err(
      new HandlerError({
        status: 502,
        message: "Failed to refresh MCP access token",
        cause: token.error,
      }),
    );
  }

  return Result.ok(token.value);
};

const discoverAuthorizationServer = async (
  authorizationServerUrl: string,
): Promise<Result<AuthorizationServerMetadata, HandlerError<502>>> => {
  for (const metadataUrl of authorizationServerMetadataUrls(
    new URL(authorizationServerUrl),
  )) {
    const result = await fetchJson({
      schema: authorizationServerMetadataSchema,
      url: metadataUrl,
    });
    if (Result.isOk(result)) {
      const safeMetadata = await validateAuthorizationServerMetadata(
        result.value,
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
  metadata: AuthorizationServerMetadata,
): Promise<Result<void, HandlerError<502>>> => {
  const urls = [
    metadata.issuer,
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ].filter((url) => url !== undefined);

  for (const url of urls) {
    const safe = await validateOutboundFetchTarget(url);
    if (Result.isError(safe)) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "MCP authorization server metadata contains an unsafe URL",
          cause: safe.error,
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

  return new Date(Date.now() + token.expires_in * 1000);
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

  return protectedResource.scopes_supported ?? [];
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
