import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { Result } from "better-result";

import { checkDemoAccountAccess } from "@/api/lib/auth/demo-account-policy";
import type { DemoAccountConfig } from "@/api/lib/auth/demo-account-policy";
import type { SafeId } from "@/api/lib/branded-types";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

const CREDENTIAL_CLEANUP_PATHS = new Set([
  "/sign-out",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
]);

export const createDemoAuthSessionGuard = (config: DemoAccountConfig) =>
  createAuthMiddleware(async (ctx) => {
    if (
      !config.email ||
      !ctx.path ||
      ctx.path === "/get-session" ||
      CREDENTIAL_CLEANUP_PATHS.has(ctx.path)
    ) {
      return;
    }
    const resolved = await getAuthoritativeSessionFromCtx(ctx);
    if (!resolved) {
      return;
    }
    const sessionAccess = checkDemoAccountAccess({
      config,
      email: resolved.user.email,
      operation: "session",
      organizationId: resolved.session["activeOrganizationId"],
    });
    if (Result.isError(sessionAccess)) {
      throw new APIError("FORBIDDEN", {
        code: "account_access_unavailable",
        message: sessionAccess.error.message,
      });
    }
    if (
      (ctx.method !== "GET" && ctx.path.startsWith("/organization/")) ||
      ctx.path.startsWith("/api-key/") ||
      ctx.path.startsWith("/oauth2/") ||
      ctx.path.startsWith("/two-factor/") ||
      ctx.path === "/link-social" ||
      ctx.path === "/delete-user" ||
      ctx.path === "/update-user" ||
      ctx.path === "/change-email" ||
      ctx.path.startsWith("/email-otp/request-email-change") ||
      ctx.path === "/email-otp/change-email"
    ) {
      const operationAccess = checkDemoAccountAccess({
        config,
        email: resolved.user.email,
        operation: "growth",
      });
      if (Result.isError(operationAccess)) {
        throw new APIError("FORBIDDEN", {
          code: "account_access_unavailable",
          message: operationAccess.error.message,
        });
      }
    }
  });

type DemoSessionPolicyOptions = {
  config: DemoAccountConfig;
  resolveUser: (
    userId: SafeId<"user">,
  ) => Promise<{ email: string } | null | undefined>;
  hasMembership: (options: {
    userId: SafeId<"user">;
    organizationId: SafeId<"organization">;
  }) => Promise<boolean>;
};

export const createDemoSessionPolicy =
  ({ config, resolveUser, hasMembership }: DemoSessionPolicyOptions) =>
  async <T extends { userId: string }>(session: T) => {
    if (!config.email || !config.organizationId) {
      return undefined;
    }
    const userId = brandPersistedUserId(session.userId);
    const account = await resolveUser(userId);
    if (!account) {
      throw new APIError("UNAUTHORIZED", { message: "Unauthorized" });
    }
    const { email } = account;
    if (email.trim().toLowerCase() !== config.email.trim().toLowerCase()) {
      return undefined;
    }
    const organizationId = config.organizationId;
    if (
      !(await hasMembership({
        userId,
        organizationId: brandPersistedOrganizationId(organizationId),
      }))
    ) {
      throw new APIError("FORBIDDEN", {
        code: "account_access_unavailable",
        message: "This operation is unavailable for this account.",
      });
    }
    return { data: { ...session, activeOrganizationId: organizationId } };
  };

export const requireDemoAccountAccess = (
  result: ReturnType<typeof checkDemoAccountAccess>,
) => {
  if (Result.isError(result)) {
    throw new APIError("FORBIDDEN", {
      code: "account_access_unavailable",
      message: result.error.message,
    });
  }
};
