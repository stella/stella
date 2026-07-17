import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { JWTPayload } from "jose";

import { getAuthEndpointUrl, getAuthIssuerUrl } from "@/api/lib/auth-paths";
import type { McpMode } from "@/api/mcp/constants";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import {
  McpAuthenticationError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";

export type McpSession = {
  userId: string;
  organizationId: string;
  scopes: string[];
};

let verifyAccessToken:
  | ReturnType<
      ReturnType<typeof oauthProviderResourceClient>["getActions"]
    >["verifyAccessToken"]
  | undefined;

const getVerifyAccessToken = () => {
  verifyAccessToken ??=
    oauthProviderResourceClient().getActions().verifyAccessToken;
  return verifyAccessToken;
};

export const getMcpAccessTokenVerificationOptions = (
  mode: McpMode = "default",
) => ({
  jwksUrl: getAuthEndpointUrl("jwks"),
  verifyOptions: {
    audience: getMcpResourceUrl(mode),
    issuer: getAuthIssuerUrl(),
  },
});

export const extractMcpSession = (payload: JWTPayload): McpSession => {
  const userId = payload.sub;
  if (!userId) {
    throw new McpAuthenticationError({ message: "Token missing sub claim" });
  }

  const rawOrganizationId = payload["org_id"];
  if (typeof rawOrganizationId !== "string" || rawOrganizationId.length === 0) {
    throw new McpAuthenticationError({
      message: "Token missing org_id claim",
    });
  }

  const rawScopes = payload["scope"];
  const scopes =
    typeof rawScopes === "string" ? rawScopes.split(" ").filter(Boolean) : [];

  return {
    userId,
    organizationId: rawOrganizationId,
    scopes,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * A genuine token rejection surfaces as a better-call `APIError` with an
 * `UNAUTHORIZED` (401) status: `verifyAccessToken` maps expired tokens, invalid
 * signatures, wrong audience/issuer, no-matching-key, and a missing payload to
 * that shape. Everything else the verifier can throw is an infrastructure fault
 * (a JWKS fetch/network error re-thrown as a plain `Error`, or a jose JWKS
 * timeout/invalid error) and must not be reported to the caller as a bad token.
 */
const isTokenRejectionError = (error: unknown): boolean =>
  isRecord(error) &&
  error["name"] === "APIError" &&
  (error["status"] === "UNAUTHORIZED" || error["statusCode"] === 401);

/**
 * Classify a failure thrown while resolving the bearer token. A genuine token
 * rejection (bad claims from `extractMcpSession`, or an `UNAUTHORIZED` verifier
 * error) becomes an `McpAuthenticationError` (surfaces as 401). An
 * infrastructure fault becomes an `McpTokenVerificationError` (captured,
 * retryable 5xx) so a JWKS outage does not masquerade as an invalid token.
 */
export const classifyMcpTokenVerificationError = (
  error: unknown,
): McpAuthenticationError | McpTokenVerificationError => {
  if (error instanceof McpAuthenticationError) {
    return error;
  }
  if (isTokenRejectionError(error)) {
    return new McpAuthenticationError({
      message: "Invalid or expired token",
      cause: error,
    });
  }
  return new McpTokenVerificationError({
    message: "Token verification is temporarily unavailable",
    cause: error,
  });
};

export const authenticateMcpRequest = async (
  bearerToken: string,
  mode: McpMode = "default",
): Promise<McpSession> => {
  try {
    const payload = await getVerifyAccessToken()(
      bearerToken,
      getMcpAccessTokenVerificationOptions(mode),
    );

    return extractMcpSession(payload);
  } catch (error) {
    throw classifyMcpTokenVerificationError(error);
  }
};
