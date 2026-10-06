import { Result } from "better-result";

import { env } from "@/api/env";
import { checkDemoAccountOperation } from "@/api/lib/auth/demo-account";
import {
  checkReviewAccountAccess,
  REVIEW_ACCOUNT_OPERATION,
} from "@/api/lib/auth/review-account-policy";
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

/**
 * Whether this account may run an operation declared
 * `ACCOUNT_ACCESS.standard`: refused for the demo account and for the
 * restricted review account.
 */
export const checkStandardAccountOperation = (
  email: string,
): Result<void, HandlerError> => {
  const demoAccess = checkDemoAccountOperation(email);
  if (Result.isError(demoAccess)) {
    return demoAccess;
  }
  return checkConfiguredReviewAccountAccess({
    email,
    operation: REVIEW_ACCOUNT_OPERATION.standardAccountOperation,
  });
};
