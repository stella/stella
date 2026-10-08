import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { resumeFlowStepsAfterGrant } from "@/api/lib/flows/flow-run-worker";
import { resumeUploadTriggersAfterGrant } from "@/api/lib/scheduler/tasks/upload-flow-trigger-recovery";

type ResumeFlowsAfterGrantOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** Rechecks the committed grant and resumes only sources accessible to its principal. */
export const resumeFlowsAfterGrant = async ({
  organizationId,
  userId,
}: ResumeFlowsAfterGrantOptions): Promise<void> => {
  await withAggregateTransaction(rootDb, async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId,
      featureId: "flows",
    });
    if (
      !(await isBackgroundFeatureEnabled({
        tx,
        organizationId,
        userId,
        featureId: "flows",
      }))
    ) {
      return;
    }
    await resumeUploadTriggersAfterGrant({
      tx,
      organizationId,
      userId,
      now: new Date(),
    });
  });
  await resumeFlowStepsAfterGrant(
    { organizationId, userId },
    { database: rootDb },
  );
};
