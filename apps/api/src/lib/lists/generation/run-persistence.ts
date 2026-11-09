/**
 * Lifecycle writes of a generation run stella produces. Each is one
 * conditional transition from the run's expected status, guarded to the
 * run's own matter, organization and producer, so a run another writer
 * already settled is left as it is and nothing is written twice.
 */

import { panic } from "better-result";
import { and, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  legalListGenerationCandidates,
  legalListGenerationCandidateSources,
  legalListGenerationRuns,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { insertInChunks } from "@/api/lib/db/bulk-write";
import { defineTransitions, transitionBatch } from "@/api/lib/db/transitions";
import type { ListGenerationRunErrorCode } from "@/api/lib/lists/generation/contract";

/** Audit operations of a run's terminal transitions; the start handler
 *  records `fact_extraction_started`. */
const FACT_EXTRACTION_OPERATION = {
  completed: "fact_extraction_completed",
  failed: "fact_extraction_failed",
} as const;

export const GENERATION_RUN_ACTIVE_STATUSES = ["queued", "running"] as const;

/** The lifecycle of a run stella produces; an external run starts running
 *  and its submit and review endpoints move it on. */
const STELLA_GENERATION_RUN_TRANSITIONS = defineTransitions(
  legalListGenerationRuns,
  {
    queued: ["running", "failed", "cancelled"],
    running: ["review", "committed", "failed", "cancelled"],
    review: ["committed", "cancelled"],
    committed: [],
    failed: [],
    cancelled: [],
  },
  { terminal: ["committed", "failed", "cancelled"] },
);

type GenerationRunScope = {
  id: SafeId<"legalListGenerationRun">;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
};

const stellaRunGuard = (run: GenerationRunScope, extra?: SQL): SQL =>
  and(
    eq(legalListGenerationRuns.workspaceId, run.workspaceId),
    eq(legalListGenerationRuns.organizationId, run.organizationId),
    eq(legalListGenerationRuns.producer, "stella"),
    extra,
  ) ?? panic("A run guard always has its scope predicates");

const readRunOwner = async (tx: Transaction, run: GenerationRunScope) =>
  (
    await tx
      .select({
        listId: legalListGenerationRuns.listId,
        requestedBy: legalListGenerationRuns.requestedBy,
      })
      .from(legalListGenerationRuns)
      .where(and(eq(legalListGenerationRuns.id, run.id), stellaRunGuard(run)))
      .limit(1)
  ).at(0);

const recordRunAuditEvent = async (
  tx: Transaction,
  run: GenerationRunScope & {
    listId: SafeId<"legalList">;
    requestedBy: string | null;
  },
  metadata: Record<string, string | number | null>,
) => {
  const record = createBackgroundAuditRecorder({
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    userId: run.requestedBy ?? "list-fact-extraction-worker",
    execution: {
      performer: {
        type: "service",
        id: "list-fact-extraction-worker",
        name: null,
      },
      trigger: { type: "system", source: "list-fact-extraction-run" },
      runId: run.id,
    },
  });
  await record(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_GENERATION,
    resourceId: run.id,
    metadata: { listId: run.listId, ...metadata },
  });
};

type ClaimGenerationRunArgs = {
  tx: Transaction;
  run: GenerationRunScope;
  requestedBy: SafeId<"user">;
};

/** `queued -> running` for the run's own requester; false when another
 *  delivery claimed it first or the run is not stella's. */
export const claimGenerationRun = async ({
  tx,
  run,
  requestedBy,
}: ClaimGenerationRunArgs): Promise<boolean> => {
  const now = new Date();
  const moved = await transitionBatch({
    tx,
    spec: STELLA_GENERATION_RUN_TRANSITIONS,
    ids: [run.id],
    options: {
      from: ["queued"],
      to: "running",
      guard: stellaRunGuard(
        run,
        eq(legalListGenerationRuns.requestedBy, requestedBy),
      ),
      set: { startedAt: now, updatedAt: now },
    },
    // Claiming assigns execution; the start and the terminal transition are
    // the audited events.
    recordTransitionAuditEvent: () => undefined,
  });
  return moved.length > 0;
};

type FailGenerationRunArgs = {
  tx: Transaction;
  run: GenerationRunScope;
  errorCode: ListGenerationRunErrorCode;
  /** Defaults to either unfinished status. */
  expectedStatus?: (typeof GENERATION_RUN_ACTIVE_STATUSES)[number];
};

/** True when this call failed the run; false when it was already settled. */
export const failGenerationRun = async ({
  tx,
  run,
  errorCode,
  expectedStatus,
}: FailGenerationRunArgs): Promise<boolean> => {
  const owner = await readRunOwner(tx, run);
  if (owner === undefined) {
    return false;
  }
  const now = new Date();
  const moved = await transitionBatch({
    tx,
    spec: STELLA_GENERATION_RUN_TRANSITIONS,
    ids: [run.id],
    options: {
      from:
        expectedStatus === undefined ? ["queued", "running"] : [expectedStatus],
      to: "failed",
      guard: stellaRunGuard(run),
      set: { errorCode, completedAt: now, updatedAt: now },
    },
    recordTransitionAuditEvent: async (auditTx, rows) => {
      if (rows.length > 0) {
        await recordRunAuditEvent(
          auditTx,
          { ...run, ...owner },
          { operation: FACT_EXTRACTION_OPERATION.failed, errorCode },
        );
      }
    },
  });
  return moved.length > 0;
};

export type GeneratedCandidate = Omit<
  typeof legalListGenerationCandidates.$inferInsert,
  "id" | "workspaceId" | "listId" | "runId" | "position" | "status"
> & {
  sources: Pick<
    typeof legalListGenerationCandidateSources.$inferInsert,
    "sourceEntityId" | "sourceEntityVersionId" | "locator" | "quote"
  >[];
};

type CompleteGenerationRunArgs = {
  tx: Transaction;
  run: GenerationRunScope;
  candidates: readonly GeneratedCandidate[];
};

/**
 * Write a running run's candidates and hand it to review; a run that found
 * nothing has nothing to review and is committed at once. A run that is no
 * longer running writes nothing.
 */
export const completeGenerationRun = async ({
  tx,
  run,
  candidates,
}: CompleteGenerationRunArgs): Promise<boolean> => {
  const owner = await readRunOwner(tx, run);
  if (owner === undefined) {
    return false;
  }
  const now = new Date();
  const settle = {
    tx,
    spec: STELLA_GENERATION_RUN_TRANSITIONS,
    ids: [run.id],
    recordTransitionAuditEvent: async (
      auditTx: Transaction,
      rows: readonly unknown[],
    ) => {
      if (rows.length > 0) {
        await recordRunAuditEvent(
          auditTx,
          { ...run, ...owner },
          {
            operation: FACT_EXTRACTION_OPERATION.completed,
            candidateCount: candidates.length,
          },
        );
      }
    },
  };
  const options = {
    guard: stellaRunGuard(run),
    set: { completedAt: now, updatedAt: now },
  };
  // A run that found nothing has nothing to review.
  const moved =
    candidates.length === 0
      ? await transitionBatch({
          ...settle,
          options: { ...options, from: ["running"], to: "committed" },
        })
      : await transitionBatch({
          ...settle,
          options: { ...options, from: ["running"], to: "review" },
        });
  if (moved.length === 0) {
    return false;
  }
  const candidateRows: (typeof legalListGenerationCandidates.$inferInsert)[] =
    [];
  const sourceRows: (typeof legalListGenerationCandidateSources.$inferInsert)[] =
    [];
  for (const [position, { sources, ...candidate }] of candidates.entries()) {
    const candidateId = createSafeId<"legalListGenerationCandidate">();
    candidateRows.push({
      ...candidate,
      id: candidateId,
      workspaceId: run.workspaceId,
      listId: owner.listId,
      runId: run.id,
      position,
    });
    for (const source of sources) {
      sourceRows.push({
        ...source,
        id: createSafeId<"legalListGenerationCandidateSource">(),
        workspaceId: run.workspaceId,
        listId: owner.listId,
        runId: run.id,
        candidateId,
      });
    }
  }
  await insertInChunks(
    candidateRows,
    async (batch) =>
      // audit: skip — the run's completion audit covers its candidates.
      await tx.insert(legalListGenerationCandidates).values(batch),
  );
  await insertInChunks(
    sourceRows,
    async (batch) =>
      // audit: skip — the run's completion audit covers its candidates.
      await tx.insert(legalListGenerationCandidateSources).values(batch),
  );
  return true;
};
