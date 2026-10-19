import type { SQL } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import type {
  SIGNALS_FEATURE_ID,
  FLOWS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";

type LockFeatureRecoveryAdmissionOptions = {
  tx: { execute: (query: SQL) => PromiseLike<unknown> };
  organizationId: SafeId<"organization">;
  featureId: typeof SIGNALS_FEATURE_ID | typeof FLOWS_FEATURE_ID;
};

/** Grant writes take this before preference rows; recovery takes it before source rows. */
export const lockFeatureRecoveryAdmission = async ({
  tx,
  organizationId,
  featureId,
}: LockFeatureRecoveryAdmissionOptions): Promise<void> => {
  await withAggregateLock({
    aggregate: "orgFeatureAdmission",
    id: { organizationId, featureId },
    tx,
  });
};

/**
 * Writers that only evaluate the current grant hold admission shared: grant
 * changes and recovery still exclude them, while independent writers of one
 * organization do not serialize on each other before their own row locks.
 */
export const lockFeatureAdmissionShared = async ({
  tx,
  organizationId,
  featureId,
}: LockFeatureRecoveryAdmissionOptions): Promise<void> => {
  await withAggregateLock({
    aggregate: "orgFeatureAdmission",
    id: { organizationId, featureId },
    mode: "shared",
    tx,
  });
};

/** Refuse an inverted wait when cleanup already holds membership or resource rows. */
export const tryLockFeatureRecoveryAdmission = async ({
  tx,
  organizationId,
  featureId,
}: LockFeatureRecoveryAdmissionOptions): Promise<boolean> => {
  const result = await withAggregateLock({
    aggregate: "orgFeatureAdmission",
    id: { organizationId, featureId },
    wait: "nowait",
    tx,
  });
  return result.status === "locked";
};
