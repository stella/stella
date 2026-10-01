import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { Result } from "better-result";

import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import {
  checkDemoAccountAccess,
  createDemoSessionPolicy,
} from "@/api/lib/demo-account-policy";

export const getDemoAccountConfig = () => ({
  email: env.DEMO_ACCOUNT_EMAIL,
  organizationId: env.DEMO_ACCOUNT_ORGANIZATION_ID,
});

export const assertDemoAccountAccess = (
  options: Omit<Parameters<typeof checkDemoAccountAccess>[0], "config">,
) => {
  const result = checkDemoAccountAccess({
    ...options,
    config: getDemoAccountConfig(),
  });
  if (Result.isError(result)) {
    throw new APIError("FORBIDDEN", {
      code: result.error.code,
      message: result.error.message,
    });
  }
};

export const checkDemoAccountOperationForUser = async (
  userId: SafeId<"user">,
) => {
  const config = getDemoAccountConfig();
  if (!config.email) {
    return Result.ok();
  }
  // The caller identity is already authenticated; this read supplies its account policy.
  const account = await rootDb.query.user.findFirst({
    where: { id: userId },
    columns: { email: true },
  });
  if (!account) {
    return Result.err(
      new APIError("UNAUTHORIZED", { message: "Unauthorized" }),
    );
  }
  return checkDemoAccountAccess({
    email: account.email,
    config,
    operation: "growth",
  });
};

const resolveDemoAccountUser = async (userId: SafeId<"user">) =>
  await rootDb.query.user.findFirst({
    where: { id: userId },
    columns: { email: true },
  });

type DemoMembershipOptions = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
};
const hasDemoAccountMembership = async ({
  userId,
  organizationId,
}: DemoMembershipOptions) =>
  Boolean(
    await rootDb.query.member.findFirst({
      where: { userId, organizationId },
      columns: { id: true },
    }),
  );

type SessionCreateHook = NonNullable<
  NonNullable<
    NonNullable<
      NonNullable<BetterAuthOptions["databaseHooks"]>["session"]
    >["create"]
  >["before"]
>;

export const createConfiguredDemoSessionPolicy =
  (): SessionCreateHook => async (session, ctx) => {
    const policy = createDemoSessionPolicy({
      config: getDemoAccountConfig(),
      resolveUser:
        ctx?.context.internalAdapter.findUserById ?? resolveDemoAccountUser,
      hasMembership: hasDemoAccountMembership,
    });
    return await policy(session);
  };
