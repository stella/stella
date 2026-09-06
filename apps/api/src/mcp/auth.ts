import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import type { JWTPayload } from "jose";
import * as v from "valibot";

import type { PermissionInput } from "@stll/permissions";

import { getAuthEndpointUrl, getAuthIssuerUrl } from "@/api/lib/auth-paths";
import {
  isMachineApiKeyCredential,
  machineApiKeyPermissionsSchema,
  parseMachineApiKeyPermissions,
} from "@/api/lib/machine-api-key-config";
import { isRecord } from "@/api/lib/type-guards";
import { AGENT_RUN_TOKEN_PURPOSE } from "@/api/mcp/agent-run-token";
import { resolveMachineApiKeySession as defaultResolveMachineApiKeySession } from "@/api/mcp/api-key-auth";
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
        type: "machine_api_key";
        id: string;
        name: string;
        permissions: PermissionInput;
      }
    | { type: "delegated_user" };
  /** Optional server-issued attenuation; absent means the full live access set. */
  workspaceIds?: string[];
};

/** Which kind of credential opened a session, for telemetry and reporting. */
export type McpCredentialType = NonNullable<McpSession["credential"]>["type"];

let verifyBearerToken:
  | ReturnType<
      ReturnType<typeof oauthProviderResourceClient>["getActions"]
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

/**
 * A credential permission set recovered from the transport slot is re-validated
 * against the canonical statement map, exactly as it was when the key first
 * resolved: the slot is opaque state, so its permission set is re-derived
 * rather than trusted.
 */
const isCredentialPermissions = (value: unknown): value is PermissionInput => {
  const parsed = v.safeParse(machineApiKeyPermissionsSchema, value);
  return (
    parsed.success &&
    parseMachineApiKeyPermissions(parsed.output).type === "valid"
  );
};

const isMcpCredential = (
  value: unknown,
): value is NonNullable<McpSession["credential"]> => {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    return false;
  }
  switch (value["type"]) {
    case "agent_run":
      return typeof value["runId"] === "string" && value["runId"].length > 0;
    case "oauth_client":
      return (
        typeof value["clientId"] === "string" && value["clientId"].length > 0
      );
    case "machine_api_key":
      return (
        typeof value["id"] === "string" &&
        value["id"].length > 0 &&
        typeof value["name"] === "string" &&
        value["name"].length > 0 &&
        isCredentialPermissions(value["permissions"])
      );
    case "delegated_user":
      return true;
    default:
      return false;
  }
};

/** Validate session state recovered from an opaque framework transport slot. */
export const isMcpSession = (value: unknown): value is McpSession =>
  isRecord(value) &&
  typeof value["userId"] === "string" &&
  value["userId"].length > 0 &&
  typeof value["organizationId"] === "string" &&
  value["organizationId"].length > 0 &&
  isStringArray(value["scopes"]) &&
  (!("credential" in value) || isMcpCredential(value["credential"])) &&
  (!("workspaceIds" in value) || isStringArray(value["workspaceIds"]));

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
  const rawClientId = payload["client_id"] ?? payload["azp"];
  const rawPurpose = payload["purpose"];
  const rawRunId = payload["run_id"];
  const rawWorkspaceIds = payload["workspace_ids"];
  if (rawWorkspaceIds !== undefined && !isStringArray(rawWorkspaceIds)) {
    throw new McpAuthenticationError({
      message: "Token has invalid workspace_ids claim",
    });
  }

  let credential: NonNullable<McpSession["credential"]>;
  if (rawPurpose === AGENT_RUN_TOKEN_PURPOSE) {
    if (typeof rawRunId !== "string" || rawRunId.length === 0) {
      throw new McpAuthenticationError({
        message: "Agent-run token missing run_id claim",
      });
    }
    if (rawWorkspaceIds === undefined) {
      throw new McpAuthenticationError({
        message: "Agent-run token missing workspace_ids claim",
      });
    }
    credential = { type: "agent_run", runId: rawRunId };
  } else {
    if (rawRunId !== undefined) {
      throw new McpAuthenticationError({
        message: "Token run_id claim requires agent-run purpose",
      });
    }
    credential =
      typeof rawClientId === "string" && rawClientId.length > 0
        ? { type: "oauth_client", clientId: rawClientId }
        : { type: "delegated_user" };
  }

  return {
    credential,
    userId,
    organizationId: rawOrganizationId,
    scopes,
    ...(rawWorkspaceIds === undefined ? {} : { workspaceIds: rawWorkspaceIds }),
  };
};

/**
 * A genuine token rejection surfaces as a better-call `APIError` with an
 * `UNAUTHORIZED` (401) status: `verifyBearerToken` maps expired tokens, invalid
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
export const authenticateMcpRequest = async (
  bearerToken: string,
  {
    mode = "default",
    resolveApiKeySession = defaultResolveMachineApiKeySession,
  }: {
    mode?: McpMode | undefined;
    resolveApiKeySession?:
      | typeof defaultResolveMachineApiKeySession
      | undefined;
  } = {},
): Promise<McpSession> => {
  if (isMachineApiKeyCredential(bearerToken)) {
    try {
      return await resolveApiKeySession(bearerToken);
    } catch (error) {
      throw classifyMcpTokenVerificationError(error);
    }
  }

  try {
    const payload = await getVerifyBearerToken()(
      bearerToken,
      getMcpAccessTokenVerificationOptions(mode),
    );

    return extractMcpSession(payload);
  } catch (error) {
    throw classifyMcpTokenVerificationError(error);
  }
};
