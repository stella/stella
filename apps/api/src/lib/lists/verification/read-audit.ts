import { panic } from "better-result";
import { lt, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { legalListVerificationReadReceipts } from "@/api/db/schema";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { CONTENT_DELIVERY_AUDIT_ACTION } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import type { readVerificationRun } from "@/api/lib/lists/verification/read-run";

type RecordVerificationReadOptions = {
  tx: Transaction;
  run: NonNullable<Awaited<ReturnType<typeof readVerificationRun>>>;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  observedAt?: Date;
};

export const recordVerificationRead = async ({
  tx,
  run,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  observedAt = new Date(),
}: RecordVerificationReadOptions): Promise<void> => {
  switch (run.status) {
    case "queued":
    case "running":
      return;
    case "completed":
    case "failed":
      break;
    default:
      run.status satisfies never;
      return panic("Unknown verification run status");
  }
  // PostgreSQL owns the Prague calendar conversion, including DST. The unique
  // receipt serializes concurrent reads; rollback also releases the daily claim.
  const day = sql`(${observedAt.toISOString()}::timestamptz AT TIME ZONE 'Europe/Prague')::date`;
  const claimed = await tx
    .insert(legalListVerificationReadReceipts)
    .values({
      organizationId,
      workspaceId,
      runId: run.id,
      userId,
      auditedDay: day,
    })
    .onConflictDoUpdate({
      target: [
        legalListVerificationReadReceipts.organizationId,
        legalListVerificationReadReceipts.workspaceId,
        legalListVerificationReadReceipts.runId,
        legalListVerificationReadReceipts.userId,
      ],
      set: { auditedDay: day },
      setWhere: lt(legalListVerificationReadReceipts.auditedDay, day),
    })
    .returning({ runId: legalListVerificationReadReceipts.runId });
  if (claimed.length === 0) {
    return;
  }
  await recordAuditEvent(tx, {
    action: CONTENT_DELIVERY_AUDIT_ACTION.inline,
    resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
    resourceId: run.entityId,
    workspaceId,
    metadata: {
      disposition: "inline",
      format: "verification-run",
      runId: run.id,
      listId: run.evidence.listId,
      fileFieldId: run.fileFieldId,
      entityVersionId: run.entityVersionId,
      status: run.status,
    },
  });
};
