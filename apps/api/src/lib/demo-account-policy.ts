import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
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
  workspace: "restricted",
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
