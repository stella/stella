import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { resumeScoutEmissionAfterGrant } from "@/api/lib/scheduler/tasks/scout-emission-recovery";
import { resumeDocumentDeadlineScoutsAfterGrant } from "@/api/lib/scouts/document-deadline-recovery";

type ResumeSignalsAfterGrantOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

/** Rechecks the committed grant and resumes only sources accessible to its principal. */
export const resumeSignalsAfterGrant = async ({
  organizationId,
  userId,
}: ResumeSignalsAfterGrantOptions): Promise<void> => {
  await rootDb.transaction(async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId,
      featureId: "signals",
    });
    if (
      !(await isBackgroundFeatureEnabled({
        tx,
        organizationId,
        userId,
        featureId: "signals",
      }))
    ) {
      return;
    }
    await resumeDocumentDeadlineScoutsAfterGrant({
      tx,
      organizationId,
      userId,
    });
    await resumeScoutEmissionAfterGrant({
      tx,
      organizationId,
      userId,
      now: new Date(),
    });
  });
};
