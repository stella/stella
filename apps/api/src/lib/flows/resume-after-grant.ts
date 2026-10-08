import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { resumeFlowStepsAfterGrant } from "@/api/lib/flows/flow-run-worker";
import { repairFlowScheduleTriggers } from "@/api/lib/flows/sync-flow-schedule-trigger";
import { resumeUploadTriggersAfterGrant } from "@/api/lib/scheduler/tasks/upload-flow-trigger-recovery";

type ResumeFlowsAfterGrantOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type ResumeFlowsAfterGrantDependencies = Parameters<
  typeof resumeFlowStepsAfterGrant
>[1];

/** Rechecks the committed grant and resumes only sources accessible to its principal. */
export const resumeFlowsAfterGrant = async (
  { organizationId, userId }: ResumeFlowsAfterGrantOptions,
  dependencies?: ResumeFlowsAfterGrantDependencies,
): Promise<void> => {
  const database = dependencies?.database ?? rootDb;
  const admitted = await withAggregateTransaction(database, async (tx) => {
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
      return false;
    }
    await resumeUploadTriggersAfterGrant({
      tx,
      organizationId,
      userId,
      now: new Date(),
    });
    return true;
  });
  if (!admitted) {
    return;
  }
  await repairFlowScheduleTriggers({
    database,
    principal: { organizationId, userId },
  });
  await resumeFlowStepsAfterGrant(
    { organizationId, userId },
    {
      database,
      ...(dependencies?.enqueueStep === undefined
        ? {}
        : { enqueueStep: dependencies.enqueueStep }),
    },
  );
};
