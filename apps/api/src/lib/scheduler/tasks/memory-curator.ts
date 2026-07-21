import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { aiMemories, auditLogs } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { drainMemoryLifecyclePhase } from "@/api/lib/memory/drain-lifecycle-phase";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const MEMORY_CURATOR_TASK = "memory.curator" as const;

const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
// These windows measure elapsed inactivity, not calendar boundaries, so a
// fixed 24-hour duration is intentional and must not drift across DST.
const MEMORY_LIFECYCLE_DAY_MS = HOURS_PER_DAY * MS_PER_HOUR;
// Unpinned active memories nobody has used in this window go stale; stale
// ones untouched for the longer window are archived. Never hard-deleted.
const STALE_AFTER_DAYS = 30;
const ARCHIVE_AFTER_DAYS = 90;
const SUGGESTION_ARCHIVE_AFTER_DAYS = 30;
const CURATION_BATCH_SIZE = 500;
// Ceiling on batches per phase per run (500k rows). A backlog larger than
// this drains across successive runs rather than holding the scheduler slot
// for an unbounded stretch.
const MAX_CURATION_BATCHES_PER_RUN = 1000;
const MEMORY_CURATOR_AUDIT_ACTOR = "system:memory-curator";

/**
 * Lifecycle sweep for AI memories: active -> stale -> archived, driven by
 * `lastUsedAt`. Pinned memories are exempt at every step. Runs on the root
 * connection (RLS-bypassing), so it operates across every tenant; scoping
 * is by status/pinned/lastUsedAt only, which is correct for a global
 * maintenance pass that never reads tenant content.
 */
export const curateAiMemories: SchedulerTask = async ({ logger, signal }) => {
  const now = Date.now();
  const staleCutoff = new Date(
    now - STALE_AFTER_DAYS * MEMORY_LIFECYCLE_DAY_MS,
  );
  const archiveCutoff = new Date(
    now - ARCHIVE_AFTER_DAYS * MEMORY_LIFECYCLE_DAY_MS,
  );
  const suggestionCutoff = new Date(
    now - SUGGESTION_ARCHIVE_AFTER_DAYS * MEMORY_LIFECYCLE_DAY_MS,
  );

  const staled = await sweepLifecyclePhase({
    signal,
    fromStatus: "active",
    newStatus: "stale",
    cutoffColumn: aiMemories.lastUsedAt,
    cutoff: staleCutoff,
  });

  const archived = await sweepLifecyclePhase({
    signal,
    fromStatus: "stale",
    newStatus: "archived",
    cutoffColumn: aiMemories.lastUsedAt,
    cutoff: archiveCutoff,
    archivedAt: new Date(now),
  });

  const archivedSuggestions = await sweepLifecyclePhase({
    signal,
    fromStatus: "suggested",
    newStatus: "archived",
    cutoffColumn: aiMemories.createdAt,
    cutoff: suggestionCutoff,
    archivedAt: new Date(now),
  });

  logger.info("scheduler.memory_curator", {
    "memory.staled": staled,
    "memory.archived": archived,
    "memory.suggestions_archived": archivedSuggestions,
  });
};

type SweepLifecyclePhaseOptions = {
  signal: AbortSignal;
  fromStatus: "active" | "stale" | "suggested";
  newStatus: "stale" | "archived";
  /**
   * Inactivity column the cutoff compares against (also the batch order):
   * `lastUsedAt` for the active/stale phases, `createdAt` for suggestions.
   * Both share one column type, so the union would be duplicated.
   */
  cutoffColumn: typeof aiMemories.lastUsedAt;
  cutoff: Date;
  archivedAt?: Date;
};

/**
 * Drain every memory past the cutoff, one bounded batch per transaction,
 * until the phase is empty. A single capped batch per nightly run would
 * strand any backlog beyond the cap for weeks.
 *
 * The batch-to-batch control flow (abort checks, the no-progress guard, and
 * the per-run ceiling) lives in `drainMemoryLifecyclePhase` so those
 * termination properties can be tested without the scheduler or a database.
 */
const sweepLifecyclePhase = async ({
  signal,
  fromStatus,
  newStatus,
  cutoffColumn,
  cutoff,
  archivedAt,
}: SweepLifecyclePhaseOptions): Promise<number> =>
  await drainMemoryLifecyclePhase({
    batchSize: CURATION_BATCH_SIZE,
    maxBatches: MAX_CURATION_BATCHES_PER_RUN,
    signal,
    selectBatch: async () =>
      await rootDb
        .select({ id: aiMemories.id })
        .from(aiMemories)
        .where(
          and(
            eq(aiMemories.status, fromStatus),
            eq(aiMemories.pinned, false),
            lt(cutoffColumn, cutoff),
          ),
        )
        .orderBy(asc(cutoffColumn))
        .limit(CURATION_BATCH_SIZE),
    transitionBatch: async (ids) =>
      await rootDb.transaction(async (tx) => {
        const rows = await tx
          .update(aiMemories)
          .set({ status: newStatus, ...(archivedAt && { archivedAt }) })
          .where(
            and(
              eq(aiMemories.status, fromStatus),
              eq(aiMemories.pinned, false),
              lt(cutoffColumn, cutoff),
              inArray(aiMemories.id, ids),
            ),
          )
          .returning(memoryLifecycleReturning);
        await recordMemoryLifecycleAuditEvents(tx, rows, {
          oldStatus: fromStatus,
          newStatus,
        });
        return rows;
      }),
  });

const memoryLifecycleReturning = {
  id: aiMemories.id,
  organizationId: aiMemories.organizationId,
  workspaceId: aiMemories.workspaceId,
};

type MemoryLifecycleRow = {
  id: SafeId<"aiMemory">;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace"> | null;
};

const recordMemoryLifecycleAuditEvents = async (
  tx: Transaction,
  rows: readonly MemoryLifecycleRow[],
  {
    oldStatus,
    newStatus,
  }: {
    oldStatus: "active" | "stale" | "suggested";
    newStatus: "stale" | "archived";
  },
): Promise<void> => {
  if (rows.length === 0) {
    return;
  }
  await tx.insert(auditLogs).values(
    rows.map((row) => ({
      id: createSafeId<"auditLog">(),
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      userId: MEMORY_CURATOR_AUDIT_ACTOR,
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.AI_MEMORY,
      resourceId: row.id,
      changes: { status: { old: oldStatus, new: newStatus } },
      metadata: { source: MEMORY_CURATOR_TASK },
    })),
  );
};
