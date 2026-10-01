import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { Result } from "better-result";

import type { statements } from "@stll/permissions";

import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

type DemoAccountConfig = {
  email: string | undefined;
  organizationId: string | undefined;
};

const isDemoAccount = ({
  email,
  config,
}: {
  email: string;
  config: DemoAccountConfig;
}) =>
  config.email !== undefined &&
  email.trim().toLowerCase() === config.email.toLowerCase();

type DemoAccountAccessOptions = {
  email: string;
  config: DemoAccountConfig;
  operation: "sign-in" | "session" | "growth";
  organizationId?: unknown;
};

export const checkDemoAccountAccess = ({
  email,
  config,
  operation,
  organizationId,
}: DemoAccountAccessOptions) => {
  if (!isDemoAccount({ email, config })) {
    return Result.ok();
  }
  if (config.organizationId && operation === "sign-in") {
    return Result.ok();
  }
  if (
    config.organizationId &&
    operation === "session" &&
    organizationId === config.organizationId
  ) {
    return Result.ok();
  }
  return Result.err(
    new HandlerError({
      status: 403,
      code: "account_access_unavailable",
      message: "This operation is unavailable for this account.",
    }),
  );
};

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
      organizationId: resolved.session.activeOrganizationId,
    });
    if (Result.isError(sessionAccess)) {
      throw new APIError("FORBIDDEN", {
        code: sessionAccess.error.code,
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
          code: operationAccess.error.code,
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
    if (!config.email) {
      return;
    }
    const userId = brandPersistedUserId(session.userId);
    const account = await resolveUser(userId);
    if (!account) {
      throw new APIError("UNAUTHORIZED", { message: "Unauthorized" });
    }
    const { email } = account;
    if (!isDemoAccount({ email, config })) {
      return;
    }
    const access = checkDemoAccountAccess({
      email,
      config,
      operation: "sign-in",
    });
    if (Result.isError(access)) {
      throw new APIError("FORBIDDEN", {
        code: access.error.code,
        message: access.error.message,
      });
    }
    const organizationId = config.organizationId;
    if (
      !organizationId ||
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

export const createDemoSessionFilter = (config: DemoAccountConfig) =>
  ({
    id: "account-session-policy",
    hooks: {
      after: [
        {
          matcher: ({ path }) => path === "/get-session",
          handler: createAuthMiddleware(async (ctx) => {
            const resolved = ctx.context.session;
            if (!resolved) {
              return;
            }
            const access = checkDemoAccountAccess({
              config,
              email: resolved.user.email,
              operation: "session",
              organizationId: resolved.session.activeOrganizationId,
            });
            if (Result.isOk(access)) {
              return;
            }
            ctx.context.session = null;
            return ctx.json(null);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

const ACCOUNT_PERMISSION_POLICY = {
  organization: "restricted",
  member: "restricted",
  invitation: "restricted",
  team: "restricted",
  ac: "restricted",
  workspace: "sandbox",
  organizationSettings: "restricted",
  integration: "restricted",
  contact: "sandbox",
  invoice: "sandbox",
  template: "sandbox",
  styleSet: "sandbox",
  clause: "sandbox",
  entity: "sandbox",
  timeEntry: "sandbox",
  expense: "sandbox",
  view: "sandbox",
  property: "sandbox",
  playbook: "sandbox",
  flow: "sandbox",
  signal: "sandbox",
  billingCode: "sandbox",
  rate: "sandbox",
  chat: "sandbox",
  auditLog: "sandbox",
  agentSkill: "sandbox",
  firmMemory: "sandbox",
  caseLawResearch: "sandbox",
  legalReaderAnnotation: "sandbox",
  savedSearch: "sandbox",
} as const satisfies Record<keyof typeof statements, "restricted" | "sandbox">;

export const requiresStandardAccount = (
  permissions: Partial<Record<keyof typeof statements, readonly string[]>>,
) =>
  Object.entries(ACCOUNT_PERMISSION_POLICY).some(
    ([resource, policy]) =>
      policy === "restricted" &&
      Object.entries(permissions).some(
        ([name, actions]) =>
          name === resource &&
          actions !== undefined &&
          actions.some((action) => action !== "read"),
      ),
  );
