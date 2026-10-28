/**
 * OAuth access tokens on the REST API.
 *
 * The API is an OAuth resource of its own (`@stll/api-contract/api-oauth-
 * resource`) that only stella's own native apps are linked to. A token for it
 * opens a route only when the route is listed in `API_OAUTH_ROUTES`
 * with the scope it requires and the token carries that scope. Every other
 * route refuses it, so the API's surface for these tokens grows one reviewed
 * entry at a time and nothing reaches it by default.
 *
 * Verification is the provider's own: signature against the JWKS, expiry,
 * issuer, and the API resource as the exact audience. A token minted for an
 * MCP audience therefore never verifies here, and a token minted for the API
 * never verifies on MCP.
 *
 * This module imports no MCP or session code, since `lib/auth.ts` resolves it
 * and the MCP modules import `lib/auth.ts`.
 */

import { Result, TaggedError } from "better-result";
import type { JWTPayload } from "jose";
import * as v from "valibot";

import type { ApiOAuthResourceScope } from "@stll/api-contract/api-oauth-resource";
import { declareFingerprintFields } from "@stll/errors";

import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
} from "@/api/lib/auth/auth-paths";
import { narrowReviewOrganizationScopes } from "@/api/lib/auth/review-account-policy";
import type { ReviewAccountConfig } from "@/api/lib/auth/review-account-policy";
import { isTokenRejectionError } from "@/api/lib/auth/token-verification-errors";
import {
  SERVICE_CLIENT_PRINCIPAL,
  SERVICE_CLIENT_PRINCIPAL_CLAIM,
} from "@/api/lib/db/service-client-contract";
import { getApiOAuthResourceIdentifier } from "@/api/lib/oauth-resource-policy";
import { getVerifyBearerToken } from "@/api/mcp/auth";
import type { VerifyBearerToken } from "@/api/mcp/auth";

/**
 * Every REST route an API access token may open, by route pattern,
 * with the scope it requires and the handler module that serves it.
 * `api-oauth-routes.test.ts` proves each entry: the live route serves that
 * handler, the handler is not account control, and the capability catalog
 * assigns its capability exactly this scope. A realtime handler has no
 * capability; its entry names that reason and the scope its domain carries,
 * and the test holds the handler to that reason instead. Account-control routes
 * (sign-in methods, keys, connections, deletion) never belong here: a lost
 * phone must not be able to keep itself connected.
 */
export const API_OAUTH_ROUTES = {
  "GET /v1/workspaces": {
    scope: "stella:read",
    handler: "apps/api/src/handlers/workspaces/list.ts",
  },
  "POST /v1/entities/:workspaceId/query": {
    scope: "stella:read",
    handler: "apps/api/src/handlers/entities/list.ts",
  },
  "GET /v1/entities/:workspaceId/entity/:entityId": {
    scope: "stella:read",
    handler: "apps/api/src/handlers/entities/get.ts",
  },
  "GET /v1/tasks": {
    scope: "stella:read",
    handler: "apps/api/src/handlers/tasks/list.ts",
  },
  // Writes act as the person: each handler keeps the permission and matter
  // access checks a browser session gets, so the token reaches no further.
  "PUT /v1/workspaces": {
    scope: "stella:matters_write",
    handler: "apps/api/src/handlers/workspaces/create.ts",
  },
  "PUT /v1/tasks/:workspaceId": {
    scope: "stella:matters_write",
    handler: "apps/api/src/handlers/tasks/create.ts",
  },
  "GET /v1/tasks/:workspaceId/:taskId": {
    scope: "stella:read",
    handler: "apps/api/src/handlers/tasks/get.ts",
  },
  "PATCH /v1/tasks/:workspaceId": {
    scope: "stella:matters_write",
    handler: "apps/api/src/handlers/tasks/update.ts",
  },
  "GET /v1/chat/threads": {
    scope: "stella:chat",
    handler: "apps/api/src/handlers/chat/threads/list.ts",
  },
  "GET /v1/chat/threads/:threadId/messages": {
    scope: "stella:chat",
    handler: "apps/api/src/handlers/chat/messages/list.ts",
  },
  "GET /v1/chat/threads/:threadId/messages/older": {
    scope: "stella:chat",
    handler: "apps/api/src/handlers/chat/older-messages/list.ts",
  },
  "POST /v1/chat": {
    scope: "stella:chat",
    handler: "apps/api/src/handlers/chat/send-message.ts",
    uncataloged: "realtime_stream",
  },
  "GET /v1/chat/threads/:threadId/turns/:turnId/resume": {
    scope: "stella:chat",
    handler: "apps/api/src/handlers/chat/turns/resume.ts",
    exportName: "probeChatTurn",
    uncataloged: "realtime_stream",
  },
  "GET /v1/chat/threads/:threadId/turns/:turnId/join": {
    scope: "stella:chat",
    handler: "apps/api/src/handlers/chat/turns/resume.ts",
    exportName: "joinChatTurn",
    uncataloged: "realtime_stream",
  },
  "POST /v1/chat/threads/:threadId/turns/:turnId/cancel": {
    scope: "stella:chat",
    handler: "apps/api/src/handlers/chat/turns/cancel.ts",
    uncataloged: "realtime_stream",
  },
} as const satisfies Record<
  string,
  {
    scope: ApiOAuthResourceScope;
    handler: `apps/api/src/handlers/${string}.ts`;
    /** The named export serving the route, when it is not the default. */
    exportName?: string;
    /** Why the handler has no capability: its `mcp.internal` reason. */
    uncataloged?: "realtime_stream";
  }
>;

const ROUTE_SCOPES: ReadonlyMap<string, ApiOAuthResourceScope> = new Map(
  Object.entries(API_OAUTH_ROUTES).map(([key, { scope }]) => [key, scope]),
);

export class ApiAccessTokenError extends TaggedError("ApiAccessTokenError")<{
  message: string;
  /** `rejected` is the caller's token (401); `unavailable` is ours (retryable 5xx). */
  reason: "rejected" | "unavailable";
  cause?: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export type ApiAccessTokenSession = {
  readonly userId: string;
  readonly organizationId: string;
  /** The membership the token was issued under; a later membership does not inherit it. */
  readonly memberId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
};

/** Three base64url segments: what a JWT looks like and a signed session token never does. */
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/u;

/**
 * The bearer of a request when it is a JWT. A signed session token
 * (`token.signature`) is left to the session path, so each credential takes
 * exactly one verification path and a failure on it is final.
 */
export const readAccessTokenBearer = (headers: Headers): string | undefined => {
  const authorization = headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/iu);
  const token = match?.[1];
  return token !== undefined && JWT_SHAPE.test(token) ? token : undefined;
};

const nonEmpty = v.pipe(v.string(), v.minLength(1));

/**
 * The claims an API token must carry. The provider mints `org_id` and
 * `member_id` for every user grant; `client_id` names the app. Agent-run and
 * service-client tokens are MCP credentials and are refused outright.
 */
const apiAccessTokenClaimsSchema = v.looseObject({
  sub: nonEmpty,
  org_id: nonEmpty,
  member_id: nonEmpty,
  client_id: v.optional(nonEmpty),
  azp: v.optional(nonEmpty),
  scope: v.optional(v.string()),
  purpose: v.optional(v.never()),
  run_id: v.optional(v.never()),
});

const readClaims = (
  payload: JWTPayload,
): Result<ApiAccessTokenSession, ApiAccessTokenError> => {
  if (payload[SERVICE_CLIENT_PRINCIPAL_CLAIM] === SERVICE_CLIENT_PRINCIPAL) {
    return Result.err(
      new ApiAccessTokenError({
        message: "A user token is required",
        reason: "rejected",
      }),
    );
  }
  const parsed = v.safeParse(apiAccessTokenClaimsSchema, payload);
  const clientId = parsed.success
    ? (parsed.output.client_id ?? parsed.output.azp)
    : undefined;
  if (!parsed.success || clientId === undefined) {
    return Result.err(
      new ApiAccessTokenError({
        message: "The token is not an API access token",
        reason: "rejected",
      }),
    );
  }
  return Result.ok({
    userId: parsed.output.sub,
    organizationId: parsed.output.org_id,
    memberId: parsed.output.member_id,
    clientId,
    scopes: (parsed.output.scope ?? "").split(" ").filter(Boolean),
  });
};

export const authenticateApiAccessToken = async (
  token: string,
  {
    reviewAccount,
    verifyToken,
  }: {
    readonly reviewAccount: Pick<ReviewAccountConfig, "organizationId">;
    readonly verifyToken?: VerifyBearerToken | undefined;
  },
): Promise<Result<ApiAccessTokenSession, ApiAccessTokenError>> => {
  const verify = verifyToken ?? getVerifyBearerToken();
  const payload = await Result.tryPromise({
    try: async () =>
      await verify(token, {
        jwksUrl: getAuthEndpointUrl("jwks"),
        verifyOptions: {
          audience: getApiOAuthResourceIdentifier(),
          issuer: getAuthIssuerUrl(),
        },
      }),
    catch: (cause) =>
      isTokenRejectionError(cause)
        ? new ApiAccessTokenError({
            message: "Invalid or expired token",
            reason: "rejected",
            cause,
          })
        : new ApiAccessTokenError({
            message: "Token verification is temporarily unavailable",
            reason: "unavailable",
            cause,
          }),
  });
  return payload
    .andThen(readClaims)
    .map((session) =>
      narrowReviewOrganizationScopes(
        { ...session, scopes: [...session.scopes] },
        reviewAccount,
      ),
    );
};

export type ApiRouteAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: "route" | "scope" };

/**
 * Whether an API token may open this route: the route must be listed and the
 * token must carry the scope it requires. Anything unlisted is refused, which
 * is what keeps the token's reach equal to this table.
 */
export const admitApiAccessTokenRoute = ({
  method,
  route,
  scopes,
}: {
  readonly method: string;
  /** Absent when no route matched, which no token opens. */
  readonly route: string | undefined;
  readonly scopes: readonly string[];
}): ApiRouteAdmission => {
  const required =
    route === undefined ? undefined : ROUTE_SCOPES.get(`${method} ${route}`);
  if (required === undefined) {
    return { admitted: false, reason: "route" };
  }
  return scopes.includes(required)
    ? { admitted: true }
    : { admitted: false, reason: "scope" };
};
