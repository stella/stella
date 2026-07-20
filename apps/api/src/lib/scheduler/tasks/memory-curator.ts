import { panic } from "better-result";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { aiMemories, auditLogs } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
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
  /** Inactivity column the cutoff compares against (also the batch order). */
  cutoffColumn: typeof aiMemories.lastUsedAt | typeof aiMemories.createdAt;
  cutoff: Date;
  archivedAt?: Date;
};

/**
 * Drain every memory past the cutoff, one bounded batch per transaction,
 * until the phase is empty. A single capped batch per nightly run would
 * strand any backlog beyond the cap for weeks.
 */
const sweepLifecyclePhase = async ({
  signal,
  fromStatus,
  newStatus,
  cutoffColumn,
  cutoff,
  archivedAt,
}: SweepLifecyclePhaseOptions): Promise<number> => {
  let total = 0;
  while (true) {
    if (signal.aborted) {
      panic("SchedulerAborted");
    }

    // oxlint-disable-next-line no-await-in-loop -- sequential batch drain; each batch depends on the previous one's commit
    const batch = await rootDb
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
      .limit(CURATION_BATCH_SIZE);

    if (batch.length === 0) {
      return total;
    }

    // oxlint-disable-next-line no-await-in-loop -- sequential batch drain; each batch depends on the previous one's commit
    const transitioned = await rootDb.transaction(async (tx) => {
      const rows = await tx
        .update(aiMemories)
        .set({ status: newStatus, ...(archivedAt && { archivedAt }) })
        .where(
          and(
            eq(aiMemories.status, fromStatus),
            eq(aiMemories.pinned, false),
            lt(cutoffColumn, cutoff),
            inArray(
              aiMemories.id,
              batch.map(({ id }) => id),
            ),
          ),
        )
        .returning(memoryLifecycleReturning);
      await recordMemoryLifecycleAuditEvents(tx, rows, {
        oldStatus: fromStatus,
        newStatus,
      });
      return rows;
    });
    total += transitioned.length;

    // Every selected row was concurrently pinned or transitioned between the
    // select and the update; stop rather than risk spinning on a batch the
    // update can never claim.
    if (transitioned.length === 0 || batch.length < CURATION_BATCH_SIZE) {
      return total;
    }
  }
};

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
