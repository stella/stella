import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  SIGNALS_FEATURE_ID,
  FLOWS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";

const FEATURE_RECOVERY_LOCK_NAMESPACE = 0x0f_10_cc_aa;

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
  await tx.execute(sql`SELECT pg_advisory_xact_lock(
    ${FEATURE_RECOVERY_LOCK_NAMESPACE}, hashtext(${`${featureId}:${organizationId}`})
  )`);
};

/** Refuse an inverted wait when cleanup already holds membership or resource rows. */
export const tryLockFeatureRecoveryAdmission = async ({
  tx,
  organizationId,
  featureId,
}: Omit<LockFeatureRecoveryAdmissionOptions, "tx"> & {
  tx: Pick<Transaction, "select">;
}): Promise<boolean> => {
  const rows = await tx.select({
    locked: sql<boolean>`pg_try_advisory_xact_lock(
      ${FEATURE_RECOVERY_LOCK_NAMESPACE}, hashtext(${`${featureId}:${organizationId}`})
    )`,
  });
  return rows.at(0)?.locked === true;
};
