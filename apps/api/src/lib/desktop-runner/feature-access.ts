import { DESKTOP_RUNNER_FEATURE_ID } from "@stll/api-contract/desktop-runner";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { resolveFeatureAccess } from "@/api/lib/auth/feature-access/context";
import type { SafeId } from "@/api/lib/branded-types";
import type { FeatureAccessGrants } from "@/api/lib/feature-access/grants-schema";

type RunnerAccount = {
  readonly userId: SafeId<"user">;
  readonly organizationId: SafeId<"organization">;
};

/** Whether an account may hold runner sockets. */
export type RunnerFeatureAccess = (account: RunnerAccount) => Promise<boolean>;

type RunnerFeatureAccessOptions = {
  db?: Pick<Transaction, "select">;
  /** The grants to decide with; the deployment's by default. */
  grants?: () => FeatureAccessGrants;
};

/**
 * The account's desktop runner feature decision, from the same feature access
 * owner that answers the desktop's own feature read.
 */
export const runnerFeatureAccess =
  ({
    db = rootDb,
    grants,
  }: RunnerFeatureAccessOptions = {}): RunnerFeatureAccess =>
  async (account: RunnerAccount) => {
    const { userId, organizationId } = account;
    const decision = await resolveFeatureAccess({
      tx: db,
      organizationId,
      userId,
      featureId: DESKTOP_RUNNER_FEATURE_ID,
      ...(grants === undefined ? {} : { grants: grants() }),
    });
    return decision.status === "enabled";
  };
