import type { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

type ReviewResetAuditOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
  runId: SafeId<"schedulerJobRun">;
};

export const reviewResetAuditContext = ({
  organizationId,
  userId,
  workspaceId,
  runId,
}: ReviewResetAuditOptions) =>
  ({
    organizationId,
    workspaceId,
    userId,
    execution: {
      performer: {
        type: "service",
        id: "review-organization-reset",
        name: "Review organization reset",
      },
      trigger: {
        type: "schedule",
        ownerUserId: userId,
        source: "scheduler",
        sourceId: runId,
      },
    },
  }) as const satisfies Parameters<typeof createBackgroundAuditRecorder>[0];
