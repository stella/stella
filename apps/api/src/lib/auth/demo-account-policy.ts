import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { Result } from "better-result";

import type { statements } from "@stll/permissions";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

export type DemoAccountConfig = {
  email: string | undefined;
  organizationId: string | undefined;
};

type DemoAccountConfigurationWarning = {
  mode: "unbound";
  missingConfig: "DEMO_ACCOUNT_ORGANIZATION_ID";
};

export const warnDemoAccountConfiguration = (
  config: DemoAccountConfig,
  warn: (attributes: DemoAccountConfigurationWarning) => void,
) => {
  if (config.email && !config.organizationId) {
    warn({ mode: "unbound", missingConfig: "DEMO_ACCOUNT_ORGANIZATION_ID" });
  }
};

const isDemoAccount = ({
  email,
  config,
}: {
  email: string;
  config: DemoAccountConfig;
}) =>
  config.email !== undefined &&
  email.trim().toLowerCase() === config.email.trim().toLowerCase();

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
  if (!config.organizationId && operation !== "growth") {
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
              return undefined;
            }
            const access = checkDemoAccountAccess({
              config,
              email: resolved.user.email,
              operation: "session",
              organizationId: resolved.session["activeOrganizationId"],
            });
            if (Result.isOk(access)) {
              return undefined;
            }
            ctx.context.session = null;
            return await ctx.json(null);
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
  accountAccess?: "standard",
) =>
  accountAccess === "standard" ||
  Object.entries(ACCOUNT_PERMISSION_POLICY).some(
    ([resource, policy]) =>
      policy === "restricted" &&
      Object.entries(permissions).some(
        ([name, actions]) =>
          name === resource && actions.some((action) => action !== "read"),
      ),
  );
