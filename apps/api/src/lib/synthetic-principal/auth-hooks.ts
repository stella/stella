import { requireReviewAccountAccess } from "@/api/lib/auth/review-account-plugin";
import { REVIEW_ACCOUNT_OPERATION } from "@/api/lib/auth/review-account-policy";
import { isSyntheticPrincipal } from "@/api/lib/synthetic-principal/constants";
import {
  checkSyntheticPrincipalAccess,
  syntheticPrincipalAuthConfig,
} from "@/api/lib/synthetic-principal/policy";

export const createSyntheticPrincipalAuthHooks = () => ({
  userCreateBefore: (user: { email: string }): undefined => {
    requireReviewAccountAccess(
      checkSyntheticPrincipalAccess({
        email: user.email,
        operation: REVIEW_ACCOUNT_OPERATION.emailCodeSignIn,
      }),
    );
    return undefined;
  },
  accountCreateBefore: (account: { userId: string }): undefined => {
    if (!isSyntheticPrincipal({ userId: account.userId })) {
      return undefined;
    }
    requireReviewAccountAccess(
      checkSyntheticPrincipalAccess({
        email: syntheticPrincipalAuthConfig.email,
        operation: REVIEW_ACCOUNT_OPERATION.linkIdentity,
      }),
    );
    return undefined;
  },
});
