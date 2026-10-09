import { Result } from "better-result";

import type { LegalResolveSession } from "@/api/lib/auth/legal-resolve-principal";
import { getReviewAccountConfig } from "@/api/lib/auth/review-account";
import { narrowReviewOrganizationScopes } from "@/api/lib/auth/review-account-policy";
import { resolveServiceOAuthToken } from "@/api/lib/auth/service-client";
import {
  SERVICE_CLIENT_PRINCIPAL,
  SERVICE_CLIENT_PRINCIPAL_CLAIM,
} from "@/api/lib/auth/service-client-policy";
import { isMachineApiKeyCredential } from "@/api/lib/machine-api-key-config";
import {
  authenticateMcpRequest,
  classifyMcpTokenVerificationError,
  extractMcpSession,
  verifyMcpAccessToken,
} from "@/api/mcp/auth";
import type { McpAuthenticationFailure } from "@/api/mcp/auth";
import { McpAuthenticationError } from "@/api/mcp/errors";

type LegalResolveAuthenticationDependencies = {
  mode?: "default" | "law";
  verifyToken?: Parameters<typeof verifyMcpAccessToken>[1]["verifyToken"];
  resolveService?: typeof resolveServiceOAuthToken;
};

export const authenticateLegalResolveToken = async (
  bearerToken: string,
  {
    mode = "law",
    verifyToken,
    resolveService = resolveServiceOAuthToken,
  }: LegalResolveAuthenticationDependencies = {},
): Promise<Result<LegalResolveSession, McpAuthenticationFailure>> => {
  if (isMachineApiKeyCredential(bearerToken)) {
    return await authenticateMcpRequest(bearerToken, { mode });
  }
  const verified = await verifyMcpAccessToken(bearerToken, {
    mode,
    ...(verifyToken === undefined ? {} : { verifyToken }),
  });
  if (Result.isError(verified)) {
    return verified;
  }
  if (
    verified.value[SERVICE_CLIENT_PRINCIPAL_CLAIM] !== SERVICE_CLIENT_PRINCIPAL
  ) {
    return extractMcpSession(verified.value).map((session) =>
      narrowReviewOrganizationScopes(session, getReviewAccountConfig()),
    );
  }
  if (mode !== "law") {
    return Result.err(
      new McpAuthenticationError({
        message: "Service clients require the law resource",
      }),
    );
  }
  const service = await Result.tryPromise({
    try: async () => await resolveService(verified.value),
    catch: classifyMcpTokenVerificationError,
  });
  if (Result.isError(service)) {
    return service;
  }
  return service.value
    ? Result.ok(service.value)
    : Result.err(
        new McpAuthenticationError({
          message: "Service client is unavailable",
        }),
      );
};
