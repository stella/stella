import { lt, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { legalListVerificationReadReceipts } from "@/api/db/schema";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { CONTENT_DELIVERY_AUDIT_ACTION } from "@/api/lib/audited-download";
import type { SafeId } from "@/api/lib/branded-types";
import type { VerificationRunStatus } from "@/api/lib/lists/verification/contract";

/** What the read audit records of a run whose content was delivered. */
type AuditedRun = {
  id: SafeId<"legalListVerificationRun">;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  listId: SafeId<"legalList">;
  status: VerificationRunStatus;
};

type RecordVerificationReadsOptions = {
  tx: Transaction;
  runs: readonly AuditedRun[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  observedAt?: Date;
};

/**
 * Audit the delivery of runs' content to a reader: once per run, reader and
 * Prague day, however many reads (the point read, the list's graph) deliver
 * it that day.
 */
export const recordVerificationReads = async ({
  tx,
  runs,
  organizationId,
  workspaceId,
  userId,
  recordAuditEvent,
  observedAt = new Date(),
}: RecordVerificationReadsOptions): Promise<void> => {
  if (runs.length === 0) {
    return;
  }
  // PostgreSQL owns the Prague calendar conversion, including DST. The unique
  // receipt serializes concurrent reads; rollback also releases the daily claim.
  const day = sql`(${observedAt.toISOString()}::timestamptz AT TIME ZONE 'Europe/Prague')::date`;
  const claimed = await tx
    .insert(legalListVerificationReadReceipts)
    .values(
      runs.map((run) => ({
        organizationId,
        workspaceId,
        runId: run.id,
        userId,
        auditedDay: day,
      })),
    )
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
  const claimedIds = new Set(claimed.map((receipt) => receipt.runId));
  const events = runs
    .filter((run) => claimedIds.has(run.id))
    .map((run): AuditEvent => ({
      action: CONTENT_DELIVERY_AUDIT_ACTION.inline,
      resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
      resourceId: run.entityId,
      workspaceId,
      metadata: {
        disposition: "inline",
        format: "verification-run",
        runId: run.id,
        listId: run.listId,
        fileFieldId: run.fileFieldId,
        entityVersionId: run.entityVersionId,
        status: run.status,
      },
    }));
  const [only, ...more] = events;
  if (only === undefined) {
    return;
  }
  // One write for every run first delivered to this reader today; a single
  // run records its event as the point read always has.
  await recordAuditEvent(tx, more.length === 0 ? only : events);
};

/** Audit one run's delivery (see `recordVerificationReads`). */
export const recordVerificationRead = async ({
  run,
  ...options
}: Omit<RecordVerificationReadsOptions, "runs"> & {
  run: Omit<AuditedRun, "listId"> & {
    evidence: { listId: SafeId<"legalList"> };
  };
}): Promise<void> =>
  await recordVerificationReads({
    ...options,
    runs: [
      {
        id: run.id,
        entityId: run.entityId,
        fileFieldId: run.fileFieldId,
        entityVersionId: run.entityVersionId,
        listId: run.evidence.listId,
        status: run.status,
      },
    ],
  });
