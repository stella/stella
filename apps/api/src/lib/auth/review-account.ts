import { Result } from "better-result";

import { env } from "@/api/env";
import type { AccountAccess } from "@/api/lib/api-handlers";
import { checkDemoAccountOperation } from "@/api/lib/auth/demo-account";
import {
  checkReviewAccountAccess,
  REVIEW_ACCOUNT_OPERATION,
} from "@/api/lib/auth/review-account-policy";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";

export const getReviewAccountConfig = () => ({
  email: env.APP_REVIEW_ACCOUNT_EMAIL,
  organizationId: env.APP_REVIEW_ORGANIZATION_ID,
});

export const isReviewAccountConfigured = () =>
  env.APP_REVIEW_ACCOUNT_EMAIL !== undefined &&
  env.APP_REVIEW_ORGANIZATION_ID !== undefined;

export const checkConfiguredReviewAccountAccess = (
  options: Omit<Parameters<typeof checkReviewAccountAccess>[0], "config">,
) => checkReviewAccountAccess({ ...options, config: getReviewAccountConfig() });

/** Whether this account may work in this organization at all. */
export const checkReviewAccountOrganization = ({
  email,
  organizationId,
}: {
  email: string;
  organizationId: SafeId<"organization">;
}): Result<void, HandlerError> =>
  checkConfiguredReviewAccountAccess({
    email,
    operation: REVIEW_ACCOUNT_OPERATION.session,
    organizationId,
  });

/**
 * Whether this account may run an operation with the declared account
 * access: `sandbox` admits everyone, `standard` refuses the demo account, and
 * `account-control` also refuses the restricted review account.
 */
export const checkRestrictedAccountOperation = (
  email: string,
  accountAccess: AccountAccess,
): Result<void, HandlerError> => {
  if (accountAccess === "sandbox") {
    return Result.ok();
  }
  const demoAccess = checkDemoAccountOperation(email);
  if (Result.isError(demoAccess)) {
    return demoAccess;
  }
  if (accountAccess === "standard") {
    return Result.ok();
  }
  return checkConfiguredReviewAccountAccess({
    email,
    operation: REVIEW_ACCOUNT_OPERATION.accountControlOperation,
  });
};
