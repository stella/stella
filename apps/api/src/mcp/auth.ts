import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { JWTPayload } from "jose";

import { getAuthEndpointUrl, getAuthIssuerUrl } from "@/api/lib/auth-paths";
import type { McpMode } from "@/api/mcp/constants";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { McpAuthenticationError } from "@/api/mcp/errors";

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
    throw new Error("Token missing sub claim");
  }

  const rawOrganizationId = payload["org_id"];
  if (typeof rawOrganizationId !== "string" || rawOrganizationId.length === 0) {
    throw new Error("Token missing org_id claim");
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
    throw new McpAuthenticationError({
      message: "Invalid or expired token",
      cause: error,
    });
  }
};
