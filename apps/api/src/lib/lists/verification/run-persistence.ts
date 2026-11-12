import { and, eq } from "drizzle-orm";

import {
  legalListClaims,
  legalListVerificationBlocks,
  legalListVerificationRuns,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { insertInChunks } from "@/api/lib/db/bulk-write";
import type { TransitionTransaction } from "@/api/lib/db/transitions";
import { defineTransitions, transition } from "@/api/lib/db/transitions";
import { writeGraphEdges } from "@/api/lib/lists/graph/edge-writer";
import { carryReviewsToRun } from "@/api/lib/lists/verification/carry-over";
import { VERIFICATION_RUN_ACTIVE_STATUSES } from "@/api/lib/lists/verification/contract";
import type {
  VerificationRunErrorCode,
  VerificationUnreadPart,
} from "@/api/lib/lists/verification/contract";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";
import { emitVerificationRunFailureMetric } from "@/api/lib/observability/request-metrics";

type VerificationTransaction = Parameters<AuditRecorder>[0] &
  TransitionTransaction;

const VERIFICATION_RUN_TRANSITIONS = defineTransitions(
  legalListVerificationRuns,
  {
    queued: ["running", "failed"],
    running: ["completed", "failed"],
    completed: [],
    failed: [],
  },
  { terminal: ["completed", "failed"] },
);

type VerificationTransitionAuditArgs = {
  tx: VerificationTransaction;
  run: {
    id: SafeId<"legalListVerificationRun">;
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace">;
    requestedBy: string | null;
  };
  status: "completed" | "failed";
  errorCode: VerificationRunErrorCode | null;
  blockCount: number;
  claimCount: number;
};

export const recordVerificationAuditEvent = async ({
  tx,
  run,
  status,
  errorCode,
  blockCount,
  claimCount,
}: VerificationTransitionAuditArgs): Promise<void> => {
  const record = createBackgroundAuditRecorder({
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    userId: run.requestedBy ?? "list-verification-worker",
    execution: {
      performer: {
        type: "service",
        id: "list-verification-worker",
        name: null,
      },
      trigger: { type: "system", source: "list-verification-run" },
      runId: run.id,
    },
  });
  await record(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
    resourceId: run.id,
    metadata: { runId: run.id, status, errorCode, blockCount, claimCount },
  });
};

type CompleteVerificationRunArgs = {
  tx: VerificationTransaction;
  runId: SafeId<"legalListVerificationRun">;
  workspaceId: SafeId<"workspace">;
  blocks: readonly VerificationBlock[];
  claims: readonly (typeof legalListClaims.$inferInsert)[];
  /** Text the run could not read; stored with the completion so a reader
   *  never sees the run whole when it is not. */
  unreadParts: readonly VerificationUnreadPart[];
};

/**
 * Store the exact source text and claims only while the run is still active,
 * then carry the previous run's review decisions to the matching claims and
 * write the graph edges the claims and carried re-checks cite, all in one
 * transaction: a run is never seen completed without them.
 */
export const completeVerificationRun = async ({
  tx,
  runId,
  workspaceId,
  blocks,
  claims,
  unreadParts,
}: CompleteVerificationRunArgs): Promise<void> => {
  const run = (
    await tx
      .select({
        id: legalListVerificationRuns.id,
        organizationId: legalListVerificationRuns.organizationId,
        workspaceId: legalListVerificationRuns.workspaceId,
        requestedBy: legalListVerificationRuns.requestedBy,
      })
      .from(legalListVerificationRuns)
      .where(
        and(
          eq(legalListVerificationRuns.id, runId),
          eq(legalListVerificationRuns.workspaceId, workspaceId),
          eq(legalListVerificationRuns.status, "running"),
        ),
      )
      .limit(1)
      .for("update")
  ).at(0);
  if (run === undefined) {
    return;
  }
  const changed = await transition({
    tx,
    spec: VERIFICATION_RUN_TRANSITIONS,
    id: runId,
    options: {
      from: ["running"],
      to: "completed",
      set: { finishedAt: new Date(), unreadParts: [...unreadParts] },
    },
    recordTransitionAuditEvent: async (auditTx) =>
      await recordVerificationAuditEvent({
        tx: auditTx,
        run,
        status: "completed",
        errorCode: null,
        blockCount: blocks.length,
        claimCount: claims.length,
      }),
  });
  if (changed.type === "stale") {
    return;
  }

  const blockRows = blocks.map((block, ordinal) => ({
    runId,
    workspaceId,
    ordinal,
    blockId: block.id,
    kind: block.source.type,
    pageNumber:
      block.source.type === "pdf-page" ? block.source.pageNumber : null,
    text: block.text,
  }));
  await insertInChunks(
    blockRows,
    async (batch) =>
      // audit: skip — engine output shares the completion audit in this transaction.
      await tx
        .insert(legalListVerificationBlocks)
        .values(batch)
        .onConflictDoNothing({
          target: [
            legalListVerificationBlocks.runId,
            legalListVerificationBlocks.ordinal,
          ],
        }),
  );
  await insertInChunks(
    claims,
    async (batch) =>
      // audit: skip — engine output shares the completion audit in this transaction.
      await tx
        .insert(legalListClaims)
        .values(batch)
        .onConflictDoNothing({
          target: [legalListClaims.runId, legalListClaims.position],
        }),
  );
  await carryReviewsToRun({ tx, runId, workspaceId });
  // Derived from the stored claims and the re-checks carried to them, so a
  // re-delivered job's edges are the ones its first delivery wrote.
  await writeGraphEdges(tx, workspaceId, { type: "run", runId });
};

type FailVerificationRunArgs = {
  tx: VerificationTransaction;
  run: {
    id: SafeId<"legalListVerificationRun">;
    workspaceId: SafeId<"workspace">;
    organizationId: SafeId<"organization">;
  };
  errorCode: VerificationRunErrorCode;
  expectedStatus?: "queued" | "running";
};

export const failVerificationRun = async ({
  tx,
  run,
  errorCode,
  expectedStatus,
}: FailVerificationRunArgs): Promise<boolean> => {
  const owned = (
    await tx
      .select({
        id: legalListVerificationRuns.id,
        workspaceId: legalListVerificationRuns.workspaceId,
        organizationId: legalListVerificationRuns.organizationId,
        requestedBy: legalListVerificationRuns.requestedBy,
      })
      .from(legalListVerificationRuns)
      .where(
        and(
          eq(legalListVerificationRuns.id, run.id),
          eq(legalListVerificationRuns.workspaceId, run.workspaceId),
          eq(legalListVerificationRuns.organizationId, run.organizationId),
        ),
      )
      .limit(1)
      .for("update")
  ).at(0);
  if (owned === undefined) {
    return false;
  }
  const changed = await transition({
    tx,
    spec: VERIFICATION_RUN_TRANSITIONS,
    id: run.id,
    options: {
      from:
        expectedStatus === undefined
          ? VERIFICATION_RUN_ACTIVE_STATUSES
          : [expectedStatus],
      to: "failed",
      set: { errorCode, finishedAt: new Date() },
    },
    recordTransitionAuditEvent: async (auditTx) =>
      await recordVerificationAuditEvent({
        tx: auditTx,
        run: owned,
        status: "failed",
        errorCode,
        blockCount: 0,
        claimCount: 0,
      }),
  });
  if (changed.type !== "transitioned") {
    return false;
  }
  emitVerificationRunFailureMetric(errorCode);
  return true;
};
