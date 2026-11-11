import { Result } from "better-result";

import { rootDb } from "@/api/db/root";
import {
  BetterAuthOAuthPolicyCensusError,
  ensureBetterAuthOAuthPolicy,
} from "@/api/lib/db/better-auth-oauth-policy-census";
import { getBetterAuthOAuthResources } from "@/api/lib/oauth-resource-policy";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const OAUTH_POLICY_CENSUS_FAILED_SINK = failureSink({
  event: "startup.oauth_policy_census_failed",
  expected: [],
});

/**
 * Seed a pristine auth database, then census the stored OAuth policy.
 *
 * A failing census never refuses boot. The policy is shared data: every task
 * already running serves under the same rows, so refusing a new task protects
 * no request, it only removes capacity until something else repairs the
 * policy. Better Auth already fails each affected request closed (an unlinked
 * client or an unknown audience is `invalid_target`), and the migrate run's
 * repair refuses to finish a deploy while the census fails. So the census is
 * reported as an error for an operator, and the rest of the API keeps serving.
 */
export const assertConfiguredBetterAuthOAuthPolicy =
  async (): Promise<void> => {
    const census = await Result.tryPromise({
      try: async () =>
        await ensureBetterAuthOAuthPolicy(
          rootDb,
          getBetterAuthOAuthResources(),
        ),
      catch: (cause) => cause,
    });
    if (Result.isOk(census)) {
      return;
    }
    if (!(census.error instanceof BetterAuthOAuthPolicyCensusError)) {
      throw census.error;
    }
    observeFailure(census.error, { sink: OAUTH_POLICY_CENSUS_FAILED_SINK });
  };
