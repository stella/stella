import { panic } from "better-result";
import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";

import { backoffDelay } from "@stll/concurrency/backoff-delay";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { documentProcessingRuns } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateRowQuery,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { defineTransitions, transition } from "@/api/lib/db/transitions";
import { DOCUMENT_PROCESSING_MAX_ATTEMPTS } from "@/api/lib/document-processing-contract";

export { DOCUMENT_PROCESSING_MAX_ATTEMPTS } from "@/api/lib/document-processing-contract";

export const documentProcessingRetryDelayMs = (attemptCount: number): number =>
  backoffDelay(Math.max(0, attemptCount - 1), {
    baseMs: 30_000,
    maxMs: 30 * 60 * 1000,
  });

export const shouldRetryDocumentProcessing = (
  attemptCount: number,
  retryable: boolean,
) => retryable && attemptCount < DOCUMENT_PROCESSING_MAX_ATTEMPTS;

type ClaimDocumentProcessingAttemptOptions = {
  database: Transaction;
  runId: SafeId<"documentProcessingRun">;
  claimToken: string;
  now: Date;
};

export const DOCUMENT_PROCESSING_RETRY_TRANSITIONS = defineTransitions(
  documentProcessingRuns,
  {
    queued: ["running", "cancelled", "failed"],
    running: ["failed", "succeeded", "queued", "cancelled"],
    failed: ["queued"],
    succeeded: ["queued"],
    cancelled: ["queued"],
  },
  { terminal: [] },
);

type FailExhaustedQueuedRunOptions = {
  database: { transaction: ScopedDb };
  runId: SafeId<"documentProcessingRun">;
  workspaceId: SafeId<"workspace">;
  now: Date;
};

/** Recheck the budget under the claim lock so a manual retry can reset it first. */
export const failExhaustedQueuedRun = async ({
  database,
  runId,
  workspaceId,
  now,
}: FailExhaustedQueuedRunOptions) =>
  await withAggregateTransaction(database, async (tx) => {
    const locked = await withAggregateRowQuery({
      tx,
      aggregate: "processingClaim",
      id: { id: runId, workspaceId },
      mode: "update",
      select: (queryTx) => queryTx.select().from(documentProcessingRuns),
      where:
        and(
          eq(documentProcessingRuns.status, "queued"),
          gte(
            documentProcessingRuns.attemptCount,
            DOCUMENT_PROCESSING_MAX_ATTEMPTS,
          ),
        ) ?? panic("Missing exhausted document processing predicate"),
    });
    const owned = locked.rows.at(0);
    if (!owned) {
      return null;
    }
    const errorCode = owned.errorCode ?? "worker_lease_expired";
    const errorMessage =
      owned.errorMessage ?? "Document processing retry budget exhausted";
    const changed = await transition({
      tx,
      spec: DOCUMENT_PROCESSING_RETRY_TRANSITIONS,
      id: runId,
      options: {
        from: ["queued"],
        to: "failed",
        set: {
          claimedAt: null,
          claimedBy: null,
          errorAt: now,
          errorCode,
          errorMessage,
          finishedAt: now,
          nextAttemptAt: null,
          nextDeliveryAt: null,
          updatedAt: now,
        },
      },
      // Reconciliation repairs worker bookkeeping; the request owns its audit event.
      recordTransitionAuditEvent: async () => await Promise.resolve(),
    });
    switch (changed.type) {
      case "stale":
        return panic("Locked exhausted document processing run changed");
      case "transitioned":
        return { errorCode, errorMessage };
      default:
        changed satisfies never;
        return panic("Unknown document processing transition outcome");
    }
  });

/** The final dispatch fence also covers duplicate and premature queue delivery. */
export const claimDocumentProcessingAttempt = async ({
  database,
  runId,
  claimToken,
  now,
}: ClaimDocumentProcessingAttemptOptions) => {
  const tx = database;
  const contexts = await tx
    .select({ workspaceId: documentProcessingRuns.workspaceId })
    .from(documentProcessingRuns)
    .where(eq(documentProcessingRuns.id, runId))
    .limit(1);
  const context = contexts.at(0);
  if (!context) {
    return null;
  }
  const locked = await withAggregateRowQuery({
    tx,
    aggregate: "processingClaim",
    id: { id: runId, workspaceId: context.workspaceId },
    mode: "update",
    select: (queryTx) => queryTx.select().from(documentProcessingRuns),
    where:
      and(
        eq(documentProcessingRuns.status, "queued"),
        lt(
          documentProcessingRuns.attemptCount,
          DOCUMENT_PROCESSING_MAX_ATTEMPTS,
        ),
        or(
          isNull(documentProcessingRuns.nextAttemptAt),
          sql`${documentProcessingRuns.nextAttemptAt} <= ${now}::timestamptz`,
        ),
      ) ?? panic("Missing document processing claim predicate"),
  });
  const owned = locked.rows.at(0);
  if (!owned) {
    return null;
  }
  const changed = await transition({
    tx,
    spec: DOCUMENT_PROCESSING_RETRY_TRANSITIONS,
    id: runId,
    options: {
      from: ["queued"],
      to: "running",
      set: {
        attemptCount: owned.attemptCount + 1,
        claimedAt: now,
        claimedBy: claimToken,
        finishedAt: null,
        nextAttemptAt: null,
        nextDeliveryAt: null,
        progressCompleted: 0,
        progressTotal: null,
        startedAt: now,
        updatedAt: now,
      },
    },
    recordTransitionAuditEvent: async () => await Promise.resolve(),
  });
  switch (changed.type) {
    case "stale":
      return null;
    case "transitioned": {
      const rows = await tx
        .select()
        .from(documentProcessingRuns)
        .where(eq(documentProcessingRuns.id, runId))
        .limit(1);
      return rows.at(0) ?? panic("Claimed document processing run disappeared");
    }
    default:
      changed satisfies never;
      return panic("Unknown document processing transition outcome");
  }
};

type FailDocumentProcessingAttemptOptions = {
  database: { transaction: ScopedDb };
  runId: SafeId<"documentProcessingRun">;
  claimToken: string;
  errorCode: string;
  errorMessage: string;
  now: Date;
  retryable?:
    | boolean
    | ((run: typeof documentProcessingRuns.$inferSelect) => boolean);
  staleBefore?: Date;
};

/** Exhausted failures are dead letters; search replay also recovers legacy null schedules. */
export const failDocumentProcessingAttempt = async ({
  database,
  runId,
  claimToken,
  errorCode,
  errorMessage,
  now,
  retryable = true,
  staleBefore,
}: FailDocumentProcessingAttemptOptions) =>
  await withAggregateTransaction(database, async (tx) => {
    const contexts = await tx
      .select({ workspaceId: documentProcessingRuns.workspaceId })
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.id, runId))
      .limit(1);
    const context = contexts.at(0);
    if (!context) {
      return null;
    }
    const locked = await withAggregateRowQuery({
      tx,
      aggregate: "processingClaim",
      id: { id: runId, workspaceId: context.workspaceId },
      mode: "update",
      select: (queryTx) => queryTx.select().from(documentProcessingRuns),
      where:
        and(
          eq(documentProcessingRuns.status, "running"),
          eq(documentProcessingRuns.claimedBy, claimToken),
          staleBefore === undefined
            ? undefined
            : sql`${documentProcessingRuns.claimedAt} < ${staleBefore}::timestamptz`,
        ) ?? panic("Missing document processing failure predicate"),
    });
    const owned = locked.rows.at(0);
    if (!owned) {
      return null;
    }
    const retryScheduled = shouldRetryDocumentProcessing(
      owned.attemptCount,
      typeof retryable === "function" ? retryable(owned) : retryable,
    );
    const changed = await transition({
      tx,
      spec: DOCUMENT_PROCESSING_RETRY_TRANSITIONS,
      id: runId,
      options: {
        from: ["running"],
        to: "failed",
        set: {
          claimedAt: null,
          claimedBy: null,
          errorAt: now,
          errorCode,
          errorMessage: errorMessage.slice(0, 2000),
          finishedAt: retryScheduled ? null : now,
          nextAttemptAt: retryScheduled
            ? new Date(
                now.getTime() +
                  documentProcessingRetryDelayMs(owned.attemptCount),
              )
            : null,
          nextDeliveryAt: null,
          updatedAt: now,
        },
      },
      recordTransitionAuditEvent: async () => await Promise.resolve(),
    });
    switch (changed.type) {
      case "stale":
        return null;
      case "transitioned":
        break;
      default:
        changed satisfies never;
        return panic("Unknown document processing transition outcome");
    }
    return { attemptCount: owned.attemptCount, retryScheduled };
  });

/** Periodic reconciliation remains bounded while sleeping through future retries. */
export const documentProcessingSleepMs = (
  nextAttemptAt: Date | null,
  now: Date,
): number =>
  nextAttemptAt === null
    ? 30_000
    : Math.max(1000, Math.min(30_000, nextAttemptAt.getTime() - now.getTime()));
