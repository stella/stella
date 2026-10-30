import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { Result } from "better-result";

import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";

import {
  getAuthEndpointUrl,
  getAuthIssuerUrl,
} from "@/api/lib/auth/auth-paths";
import {
  admitMcpSession,
  classifyMcpTokenVerificationError,
  verifyOAuthToken,
} from "@/api/lib/auth/oauth-grant-admission";
import type { AdmittedMcpSession } from "@/api/lib/auth/oauth-grant-admission";
import { getReviewAccountConfig } from "@/api/lib/auth/review-account";
import { narrowReviewOrganizationScopes } from "@/api/lib/auth/review-account-policy";
import type { ReviewAccountConfig } from "@/api/lib/auth/review-account-policy";
import { isMachineApiKeyCredential } from "@/api/lib/machine-api-key-config";
import type { resolveMachineApiKeySession } from "@/api/mcp/api-key-auth";
import type { McpMode } from "@/api/mcp/constants";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import type { McpTokenVerificationError } from "@/api/mcp/errors";
import { McpAuthenticationError } from "@/api/mcp/errors";
import {
  getMcpResourceScopes,
  MCP_MODES,
} from "@/api/mcp/resource-policy-contract";
import type { McpSession } from "@/api/mcp/session";

export type { McpSession } from "@/api/mcp/session";

/** Which kind of credential opened a session, for telemetry and reporting. */
export type McpCredentialType = NonNullable<McpSession["credential"]>["type"];

export type VerifyBearerToken = ReturnType<
  ReturnType<typeof oauthProviderResourceClient<undefined>>["getActions"]
>["verifyBearerToken"];

let verifyBearerToken: VerifyBearerToken | undefined;

export const getVerifyBearerToken = (): VerifyBearerToken => {
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

export {
  extractMcpSession,
  classifyMcpTokenVerificationError,
} from "@/api/lib/auth/oauth-grant-admission";

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
  verifyToken?: VerifyBearerToken | undefined;
  admissionOptions?: Parameters<typeof admitMcpSession>[1];
};

export const verifyMcpAccessToken = async (
  bearerToken: string,
  { mode, verifyToken, admissionOptions }: VerifyMcpAccessTokenOptions,
) =>
  await verifyOAuthToken(bearerToken, {
    verificationOptions: getMcpAccessTokenVerificationOptions(mode),
    verifyToken: verifyToken ?? getVerifyBearerToken(),
    admissionOptions,
  });

/**
 * The caller supplies the API key resolver: it reads members through the auth
 * module, which reaches this one for the bearer verifier, so importing it here
 * would close an import cycle.
 */
export const authenticateMcpRequest = async (
  bearerToken: string,
  {
    mode = "default",
    resolveApiKeySession,
    reviewAccount = getReviewAccountConfig(),
    verifyToken,
    admissionOptions,
  }: {
    mode?: McpMode | undefined;
    reviewAccount?: Pick<ReviewAccountConfig, "organizationId"> | undefined;
    resolveApiKeySession: typeof resolveMachineApiKeySession;
    verifyToken?: VerifyBearerToken | undefined;
    admissionOptions?: Parameters<typeof admitMcpSession>[1];
  },
): Promise<Result<AdmittedMcpSession, McpAuthenticationFailure>> => {
  if (isMachineApiKeyCredential(bearerToken)) {
    const authenticated = await Result.tryPromise({
      try: async () => await resolveApiKeySession(bearerToken, { mode }),
      catch: classifyMcpTokenVerificationError,
    });
    if (authenticated.isErr()) {
      return authenticated;
    }
    return await admitMcpSession(
      narrowReviewOrganizationScopes(authenticated.value, reviewAccount),
      admissionOptions,
    );
  }
  const verified = await verifyMcpAccessToken(bearerToken, {
    mode,
    verifyToken: verifyToken ?? getVerifyBearerToken(),
    admissionOptions,
  });
  if (verified.isErr()) {
    return verified;
  }
  if (verified.value.type === "service") {
    return Result.err(
      new McpAuthenticationError({ message: "A user token is required" }),
    );
  }
  return Result.ok(
    narrowReviewOrganizationScopes(verified.value.session, reviewAccount),
  );
};

/** Only resource audiences advertising account consent may deliver exports. */
export const authenticateAccountExportRequest = async (
  bearerToken: string,
  {
    verifyToken,
    admissionOptions,
    reviewAccount = getReviewAccountConfig(),
  }: {
    verifyToken?: VerifyBearerToken | undefined;
    admissionOptions?: Parameters<typeof admitMcpSession>[1];
    reviewAccount?: Pick<ReviewAccountConfig, "organizationId">;
  } = {},
): Promise<Result<AdmittedMcpSession, McpAuthenticationFailure>> => {
  if (isMachineApiKeyCredential(bearerToken)) {
    return Result.err(
      new McpAuthenticationError({
        message: "Account exports require OAuth consent",
      }),
    );
  }
  const audiences = MCP_MODES.filter((mode) =>
    getMcpResourceScopes(mode).some(
      (scope) => scope === ACCOUNT_EXPORT_SCOPES.read,
    ),
  ).map((mode) => getMcpResourceUrl(mode));
  const options = getMcpAccessTokenVerificationOptions();
  const authenticated = await verifyOAuthToken(bearerToken, {
    verificationOptions: {
      ...options,
      verifyOptions: { ...options.verifyOptions, audience: audiences },
    },
    verifyToken: verifyToken ?? getVerifyBearerToken(),
    admissionOptions,
  });
  if (authenticated.isErr()) {
    return authenticated;
  }
  if (authenticated.value.type === "service") {
    return Result.err(
      new McpAuthenticationError({ message: "A user token is required" }),
    );
  }
  return Result.ok(
    narrowReviewOrganizationScopes(authenticated.value.session, reviewAccount),
  );
};
