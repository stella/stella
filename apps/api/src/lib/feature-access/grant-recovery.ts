import { panic, Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import type { SELF_SERVE_FEATURE_IDS } from "@/api/lib/feature-access/registry";
import {
  FLOWS_FEATURE_ID,
  SIGNALS_FEATURE_ID,
} from "@/api/lib/feature-access/registry";
import { resumeFlowsAfterGrant } from "@/api/lib/flows/grant-recovery";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { resumeSignalsAfterGrant } from "@/api/lib/signals/grant-recovery";

const GRANT_RECOVERY_FAILURE = failureSink({
  event: "feature.grant_recovery_failed",
  expected: [],
});
type ResumeFeatureAfterGrantOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  featureId: (typeof SELF_SERVE_FEATURE_IDS)[number];
};
/** A failed wake leaves indexed durable sources available for periodic repair. */
export const resumeFeatureAfterGrant = async ({
  organizationId,
  userId,
  featureId,
}: ResumeFeatureAfterGrantOptions): Promise<void> => {
  const result = await Result.tryPromise(async () => {
    switch (featureId) {
      case SIGNALS_FEATURE_ID:
        await resumeSignalsAfterGrant({ organizationId, userId });
        return;
      case FLOWS_FEATURE_ID:
        await resumeFlowsAfterGrant({ organizationId, userId });
        return;
      case "time-billing":
        return;
      default: {
        featureId satisfies never;
        return panic("Unknown self-serve feature");
      }
    }
  });
  if (result.isErr()) {
    observeFailure(result.error, {
      sink: GRANT_RECOVERY_FAILURE,
      ctx: { organizationId, feature: featureId },
    });
  }
};
