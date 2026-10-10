import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { Result } from "better-result";

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
