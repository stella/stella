import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { Result } from "better-result";
import type { JWTPayload } from "jose";

import type { PermissionInput } from "@stll/permissions";

import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
} from "@/api/lib/auth/auth-paths";
import { getReviewAccountConfig } from "@/api/lib/auth/review-account";
import { narrowReviewOrganizationScopes } from "@/api/lib/auth/review-account-policy";
import type { ReviewAccountConfig } from "@/api/lib/auth/review-account-policy";
import { isTokenRejectionError } from "@/api/lib/auth/token-verification-errors";
import {
  SERVICE_CLIENT_PRINCIPAL,
  SERVICE_CLIENT_PRINCIPAL_CLAIM,
} from "@/api/lib/db/service-client-contract";
import { isMachineApiKeyCredential } from "@/api/lib/machine-api-key-config";
import { AGENT_RUN_TOKEN_PURPOSE } from "@/api/mcp/agent-run-token";
import { resolveMachineApiKeySession as defaultResolveMachineApiKeySession } from "@/api/mcp/api-key-auth";
import type { McpMode } from "@/api/mcp/constants";
import { getMcpResourceUrl, MCP_MEMBER_ID_CLAIM } from "@/api/mcp/constants";
import {
  McpAuthenticationError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";

export type McpSession = {
  userId: string;
  organizationId: string;
  scopes: string[];
  credential?:
    | { type: "agent_run"; runId: string }
    | { type: "oauth_client"; clientId: string }
    /**
     * `permissions` is the key's own permission set, already checked to be a
     * subset of its owner's current role when the credential resolved. It rides
     * on the credential because it is the credential's attenuation, and the
     * authorization path ANDs it with the role
     * (`mcp/effective-authority.ts`). A key with no usable set never resolves,
     * so the field is required on this branch.
     */
    | {
        type: "machine_api_key" | "personal_api_key";
        id: string;
        name: string;
        permissions: PermissionInput;
      }
    | { type: "delegated_user" };
  /** Optional server-issued attenuation; absent means the full live access set. */
  workspaceIds?: string[];
  /**
   * The membership row an OAuth access token was issued under; the session
   * opens only while that row is the user's current membership. Absent on
   * credentials that carry no such claim.
   */
  memberId?: string;
};

/** Which kind of credential opened a session, for telemetry and reporting. */
export type McpCredentialType = NonNullable<McpSession["credential"]>["type"];

let verifyBearerToken:
  | ReturnType<
      ReturnType<typeof oauthProviderResourceClient<undefined>>["getActions"]
    >["verifyBearerToken"]
  | undefined;

const getVerifyBearerToken = () => {
  verifyBearerToken ??=
    oauthProviderResourceClient().getActions().verifyBearerToken;
  return verifyBearerToken;
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

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string" && item.length > 0);

export const extractMcpSession = (
  payload: JWTPayload,
): Result<McpSession, McpAuthenticationError> => {
  if (payload[SERVICE_CLIENT_PRINCIPAL_CLAIM] === SERVICE_CLIENT_PRINCIPAL) {
    return Result.err(
      new McpAuthenticationError({ message: "A user token is required" }),
    );
  }
  const userId = payload.sub;
  if (!userId) {
    return Result.err(
      new McpAuthenticationError({ message: "Token missing sub claim" }),
    );
  }

  const rawOrganizationId = payload["org_id"];
  if (typeof rawOrganizationId !== "string" || rawOrganizationId.length === 0) {
    return Result.err(
      new McpAuthenticationError({ message: "Token missing org_id claim" }),
    );
  }

  const rawScopes = payload["scope"];
  const scopes =
    typeof rawScopes === "string" ? rawScopes.split(" ").filter(Boolean) : [];
  const rawClientId = payload["client_id"] ?? payload["azp"];
  const rawPurpose = payload["purpose"];
  const rawRunId = payload["run_id"];
  const rawWorkspaceIds = payload["workspace_ids"];
  if (rawWorkspaceIds !== undefined && !isStringArray(rawWorkspaceIds)) {
    return Result.err(
      new McpAuthenticationError({
        message: "Token has invalid workspace_ids claim",
      }),
    );
  }
  const rawMemberId = payload[MCP_MEMBER_ID_CLAIM];
  if (
    rawMemberId !== undefined &&
    (typeof rawMemberId !== "string" || rawMemberId.length === 0)
  ) {
    return Result.err(
      new McpAuthenticationError({
        message: "Token has invalid member_id claim",
      }),
    );
  }

  let credential: NonNullable<McpSession["credential"]>;
  if (rawPurpose === AGENT_RUN_TOKEN_PURPOSE) {
    if (typeof rawRunId !== "string" || rawRunId.length === 0) {
      return Result.err(
        new McpAuthenticationError({
          message: "Agent-run token missing run_id claim",
        }),
      );
    }
    if (rawWorkspaceIds === undefined) {
      return Result.err(
        new McpAuthenticationError({
          message: "Agent-run token missing workspace_ids claim",
        }),
      );
    }
    credential = { type: "agent_run", runId: rawRunId };
  } else {
    if (rawRunId !== undefined) {
      return Result.err(
        new McpAuthenticationError({
          message: "Token run_id claim requires agent-run purpose",
        }),
      );
    }
    credential =
      typeof rawClientId === "string" && rawClientId.length > 0
        ? { type: "oauth_client", clientId: rawClientId }
        : { type: "delegated_user" };
  }

  return Result.ok({
    credential,
    userId,
    organizationId: rawOrganizationId,
    scopes,
    ...(rawWorkspaceIds === undefined ? {} : { workspaceIds: rawWorkspaceIds }),
    ...(rawMemberId === undefined ? {} : { memberId: rawMemberId }),
  });
};

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
  // Already-classified faults are returned as-is so re-classification is
  // idempotent and never nests a verification error inside another one.
  if (error instanceof McpTokenVerificationError) {
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

/**
 * Authenticate an MCP request from its bearer credential.
 *
 * Two credential types are accepted and they are told apart by shape, not by
 * fallback: a machine API key carries a fixed prefix that a JWT (three
 * base64url segments) can never produce, so each credential takes exactly one
 * verification path and a failure on that path is final. Nothing is retried
 * against the other verifier — that would turn either verifier's rejection into
 * a second chance at the other.
 *
 * Both paths produce the same `McpSession`, which `resolveMcpSessionContext`
 * then authorizes identically: same member lookup, same RLS identity.
 */
export type McpAuthenticationFailure =
  McpAuthenticationError | McpTokenVerificationError;

type VerifyMcpAccessTokenOptions = {
  mode: McpMode;
  verifyToken?: ReturnType<typeof getVerifyBearerToken>;
};

export const verifyMcpAccessToken = async (
  bearerToken: string,
  { mode, verifyToken }: VerifyMcpAccessTokenOptions,
) =>
  await Result.tryPromise({
    try: async () =>
      await (verifyToken ?? getVerifyBearerToken())(
        bearerToken,
        getMcpAccessTokenVerificationOptions(mode),
      ),
    catch: classifyMcpTokenVerificationError,
  });

export const authenticateMcpRequest = async (
  bearerToken: string,
  {
    mode = "default",
    resolveApiKeySession = defaultResolveMachineApiKeySession,
    reviewAccount = getReviewAccountConfig(),
    verifyToken,
  }: {
    mode?: McpMode | undefined;
    reviewAccount?: Pick<ReviewAccountConfig, "organizationId"> | undefined;
    resolveApiKeySession?:
      typeof defaultResolveMachineApiKeySession | undefined;
    verifyToken?: ReturnType<typeof getVerifyBearerToken>;
  } = {},
): Promise<Result<McpSession, McpAuthenticationFailure>> => {
  const authenticated = isMachineApiKeyCredential(bearerToken)
    ? await Result.tryPromise({
        try: async () => await resolveApiKeySession(bearerToken, { mode }),
        catch: classifyMcpTokenVerificationError,
      })
    : (
        await verifyMcpAccessToken(bearerToken, {
          mode,
          ...(verifyToken === undefined ? {} : { verifyToken }),
        })
      ).andThen(extractMcpSession);
  return authenticated.map((session) =>
    narrowReviewOrganizationScopes(session, reviewAccount),
  );
};
