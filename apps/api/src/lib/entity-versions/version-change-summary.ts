import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import { summarizeVersionDiff } from "@/api/lib/ai-change-summary";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import type { SafeId } from "@/api/lib/branded-types";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { buildLineDiffSegments, diffSegmentsToText } from "@/api/lib/text-diff";

type SummarizeVersionChangeOptions = {
  prevText: string;
  currentText: string;
  /** Analytics feature the model call is reported under. */
  feature: string;
  orgAIConfig: OrgAIConfig | null;
  managedAIResidency: ManagedAIResidency;
  organizationId: SafeId<"organization">;
  admission: ModelDispatchAdmission;
  safeDb: SafeDb;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

/**
 * Prose summary of the line diff between two version texts, metered to the
 * caller. `null` when the texts are identical, without calling the model.
 */
export const summarizeVersionChange = async ({
  prevText,
  currentText,
  feature,
  orgAIConfig,
  managedAIResidency,
  organizationId,
  admission,
  safeDb,
  userId,
  workspaceId,
}: SummarizeVersionChangeOptions): Promise<
  Result<string | null, HandlerError>
> => {
  const segments = buildLineDiffSegments(prevText, currentText);
  if (segments.length === 0) {
    return Result.ok(null);
  }

  const aiAnalytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    usageMetering: {
      actionType: "chat",
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId,
      workspaceId,
    },
    feature,
    modelRole: "fast",
    orgAIConfig,
    properties: { organization_id: organizationId },
    traceId: Bun.randomUUIDv7(),
  });

  return await Result.tryPromise({
    try: async () =>
      await summarizeVersionDiff({
        diffText: diffSegmentsToText(segments),
        orgAIConfig,
        managedAIResidency,
        organizationId,
        admission,
        aiAnalytics,
      }),
    catch: (cause) => {
      aiAnalytics.captureError(cause);
      return new HandlerError({
        status: 500,
        message: "Failed to summarize version changes",
        cause,
      });
    },
  });
};
