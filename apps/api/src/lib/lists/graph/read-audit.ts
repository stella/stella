import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { legalListVerificationRuns } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { GraphNodeView } from "@/api/lib/lists/graph/read";
import { deliveredRunIds } from "@/api/lib/lists/graph/read";
import { recordVerificationReads } from "@/api/lib/lists/verification/read-audit";
import { verificationRunListIdColumn } from "@/api/lib/lists/verification/read-run";

/**
 * Audit a graph read that delivered claims' words: each claim's run is
 * recorded as read, once per reader and day, the way the run's own read is.
 */
export const recordGraphReads = async ({
  tx,
  nodes,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
}: {
  tx: Transaction;
  nodes: readonly GraphNodeView[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
}): Promise<void> => {
  const runIds = deliveredRunIds(nodes);
  if (runIds.length === 0) {
    return;
  }
  const runs = await tx
    .select({
      id: legalListVerificationRuns.id,
      entityId: legalListVerificationRuns.entityId,
      fileFieldId: legalListVerificationRuns.fileFieldId,
      entityVersionId: legalListVerificationRuns.entityVersionId,
      listId: verificationRunListIdColumn,
      status: legalListVerificationRuns.status,
    })
    .from(legalListVerificationRuns)
    .where(
      and(
        eq(legalListVerificationRuns.workspaceId, workspaceId),
        inArray(legalListVerificationRuns.id, runIds),
      ),
    );
  await recordVerificationReads({
    tx,
    runs,
    organizationId,
    workspaceId,
    userId,
    recordAuditEvent,
  });
};
