import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";

type RequireFlowEffectAdmissionOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: string | null;
};

/** Acquire the shared grant lock before checking live admission or resource locks. */
export const isFlowEffectAdmitted = async ({
  tx,
  organizationId,
  userId,
}: RequireFlowEffectAdmissionOptions): Promise<boolean> => {
  await lockFeatureRecoveryAdmission({
    tx,
    organizationId,
    featureId: "flows",
  });
  return await isBackgroundFeatureEnabled({
    tx,
    organizationId,
    userId,
    featureId: "flows",
  });
};

/** Use inside abortableTx/resultTx, before resource locks and feature writes. */
export const requireFlowEffectAdmission = async (
  options: RequireFlowEffectAdmissionOptions,
): Promise<void> => {
  if (!(await isFlowEffectAdmitted(options))) {
    abortTransaction(new HandlerError({ status: 404, message: "Not found" }));
  }
};
