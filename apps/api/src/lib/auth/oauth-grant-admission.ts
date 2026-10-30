import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { Result } from "better-result";
import type { JWTPayload } from "jose";

import { readOAuthGrantAdmission } from "@/api/db/root";
import { OAUTH_GRANT_ID_CLAIM } from "@/api/lib/auth/oauth-grant-identity";
import { isTokenRejectionError } from "@/api/lib/auth/token-verification-errors";
import {
  SERVICE_CLIENT_PRINCIPAL,
  SERVICE_CLIENT_PRINCIPAL_CLAIM,
} from "@/api/lib/db/service-client-contract";
import type { McpSession } from "@/api/mcp/auth";
import {
  AGENT_RUN_TOKEN_PURPOSE,
  MCP_MEMBER_ID_CLAIM,
} from "@/api/mcp/constants";
import {
  McpAuthenticationError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";

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
    if (typeof rawClientId === "string" && rawClientId.length > 0) {
      if (!Number.isInteger(payload.iat) || payload.iat === undefined) {
        return Result.err(
          new McpAuthenticationError({ message: "Token missing iat claim" }),
        );
      }
      credential = {
        type: "oauth_client",
        clientId: rawClientId,
        ...(typeof payload[OAUTH_GRANT_ID_CLAIM] === "string"
          ? { grantId: payload[OAUTH_GRANT_ID_CLAIM] }
          : {}),
        issuedAt: payload.iat,
      };
    } else {
      credential = { type: "delegated_user" };
    }
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

export const OAUTH_REVOCATION_CLOCK_SKEW_SECONDS = 5;

const admittedOAuthCredential = Symbol("admittedOAuthCredential");
type OAuthCredential = Extract<
  NonNullable<McpSession["credential"]>,
  { type: "oauth_client" }
>;
export type AdmittedOAuthCredential = OAuthCredential & {
  readonly [admittedOAuthCredential]: true;
  readonly registrationId: string | null;
};
export type AdmittedMcpSession = Omit<McpSession, "credential"> & {
  credential?:
    | Exclude<NonNullable<McpSession["credential"]>, OAuthCredential>
    | AdmittedOAuthCredential;
};

type AdmitOAuthCredentialOptions = {
  credential: OAuthCredential;
  organizationId: string;
  userId: string;
  db?: Parameters<typeof readOAuthGrantAdmission>[0]["db"];
};

/**
 * Owner-level admission reads the deny-by-default OAuth control-plane rows.
 * Bind registration attribution in the same read to avoid a second lookup.
 */
export const admitOAuthCredential = async ({
  credential,
  organizationId,
  userId,
  db,
}: AdmitOAuthCredentialOptions): Promise<
  Result<AdmittedOAuthCredential, McpAuthenticationError>
> => {
  const match = await readOAuthGrantAdmission({
    clientId: credential.clientId,
    organizationId,
    userId,
    grantId: credential.grantId,
    issuedAtCutoff: credential.issuedAt - OAUTH_REVOCATION_CLOCK_SKEW_SECONDS,
    db,
  });
  if (match?.revokedAt !== null && match?.revokedAt !== undefined) {
    return Result.err(
      new McpAuthenticationError({ message: "Invalid or expired token" }),
    );
  }
  return Result.ok({
    ...credential,
    [admittedOAuthCredential]: true,
    registrationId: match?.registrationId ?? null,
  });
};

type AdmitMcpSessionOptions = {
  db?: Parameters<typeof readOAuthGrantAdmission>[0]["db"];
};

export const admitMcpSession = async (
  { credential, ...session }: McpSession,
  options: AdmitMcpSessionOptions = {},
): Promise<
  Result<AdmittedMcpSession, McpAuthenticationError | McpTokenVerificationError>
> => {
  if (credential?.type !== "oauth_client") {
    return Result.ok({
      ...session,
      ...(credential === undefined ? {} : { credential }),
    });
  }
  const admitted = await Result.tryPromise({
    try: async () =>
      await admitOAuthCredential({
        credential,
        organizationId: session.organizationId,
        userId: session.userId,
        ...options,
      }),
    catch: (cause) =>
      new McpTokenVerificationError({
        message: "Token admission is temporarily unavailable",
        cause,
      }),
  });
  if (admitted.isErr()) {
    return admitted;
  }
  return admitted.value.map((value) => ({ ...session, credential: value }));
};

export type VerifyBearerToken = ReturnType<
  ReturnType<typeof oauthProviderResourceClient<undefined>>["getActions"]
>["verifyBearerToken"];

let verifyBearerToken: VerifyBearerToken | undefined;

const getVerifyBearerToken = (): VerifyBearerToken => {
  verifyBearerToken ??=
    oauthProviderResourceClient().getActions().verifyBearerToken;
  return verifyBearerToken;
};

const admittedServiceToken = Symbol("admittedServiceToken");
type AdmittedServicePayload = JWTPayload & {
  readonly [admittedServiceToken]: true;
};
type VerifiedOAuthToken =
  | { type: "user"; payload: JWTPayload; session: AdmittedMcpSession }
  | { type: "service"; payload: AdmittedServicePayload };

type VerifyOAuthTokenOptions = {
  verificationOptions: Parameters<VerifyBearerToken>[1];
  verifyToken?: VerifyBearerToken | undefined;
  admissionOptions?: AdmitMcpSessionOptions | undefined;
};

/** Signature verification and user-grant admission form one resource boundary. */
export const verifyOAuthToken = async (
  token: string,
  {
    verificationOptions,
    verifyToken,
    admissionOptions,
  }: VerifyOAuthTokenOptions,
): Promise<
  Result<VerifiedOAuthToken, McpAuthenticationError | McpTokenVerificationError>
> => {
  const verified = await Result.tryPromise({
    try: async () =>
      await (verifyToken ?? getVerifyBearerToken())(token, verificationOptions),
    catch: classifyMcpTokenVerificationError,
  });
  if (verified.isErr()) {
    return verified;
  }
  const payload = verified.value;
  if (payload[SERVICE_CLIENT_PRINCIPAL_CLAIM] === SERVICE_CLIENT_PRINCIPAL) {
    return Result.ok({
      type: "service",
      payload: { ...payload, [admittedServiceToken]: true },
    } as const satisfies VerifiedOAuthToken);
  }
  const extracted = extractMcpSession(payload);
  if (extracted.isErr()) {
    return extracted;
  }
  const admitted = await admitMcpSession(extracted.value, admissionOptions);
  return admitted.map(
    (session) =>
      ({
        type: "user",
        payload,
        session,
      }) as const satisfies VerifiedOAuthToken,
  );
};
