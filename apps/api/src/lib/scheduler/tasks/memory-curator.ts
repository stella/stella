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

  const activeIds = await rootDb
    .select({ id: aiMemories.id })
    .from(aiMemories)
    .where(
      and(
        eq(aiMemories.status, "active"),
        eq(aiMemories.pinned, false),
        lt(aiMemories.lastUsedAt, staleCutoff),
      ),
    )
    .orderBy(asc(aiMemories.lastUsedAt))
    .limit(CURATION_BATCH_SIZE);

  const staled =
    activeIds.length > 0
      ? await rootDb.transaction(async (tx) => {
          const transitioned = await tx
            .update(aiMemories)
            .set({ status: "stale" })
            .where(
              and(
                eq(aiMemories.status, "active"),
                eq(aiMemories.pinned, false),
                lt(aiMemories.lastUsedAt, staleCutoff),
                inArray(
                  aiMemories.id,
                  activeIds.map(({ id }) => id),
                ),
              ),
            )
            .returning(memoryLifecycleReturning);
          await recordMemoryLifecycleAuditEvents(tx, transitioned, {
            oldStatus: "active",
            newStatus: "stale",
          });
          return transitioned;
        })
      : [];

  if (signal.aborted) {
    panic("SchedulerAborted");
  }

  const staleIds = await rootDb
    .select({ id: aiMemories.id })
    .from(aiMemories)
    .where(
      and(
        eq(aiMemories.status, "stale"),
        eq(aiMemories.pinned, false),
        lt(aiMemories.lastUsedAt, archiveCutoff),
      ),
    )
    .orderBy(asc(aiMemories.lastUsedAt))
    .limit(CURATION_BATCH_SIZE);

  const archived =
    staleIds.length > 0
      ? await rootDb.transaction(async (tx) => {
          const transitioned = await tx
            .update(aiMemories)
            .set({ status: "archived", archivedAt: new Date(now) })
            .where(
              and(
                eq(aiMemories.status, "stale"),
                eq(aiMemories.pinned, false),
                lt(aiMemories.lastUsedAt, archiveCutoff),
                inArray(
                  aiMemories.id,
                  staleIds.map(({ id }) => id),
                ),
              ),
            )
            .returning(memoryLifecycleReturning);
          await recordMemoryLifecycleAuditEvents(tx, transitioned, {
            oldStatus: "stale",
            newStatus: "archived",
          });
          return transitioned;
        })
      : [];

  const suggestionCutoff = new Date(
    now - SUGGESTION_ARCHIVE_AFTER_DAYS * MEMORY_LIFECYCLE_DAY_MS,
  );
  const suggestedIds = await rootDb
    .select({ id: aiMemories.id })
    .from(aiMemories)
    .where(
      and(
        eq(aiMemories.status, "suggested"),
        eq(aiMemories.pinned, false),
        lt(aiMemories.createdAt, suggestionCutoff),
      ),
    )
    .orderBy(asc(aiMemories.createdAt))
    .limit(CURATION_BATCH_SIZE);

  const archivedSuggestions =
    suggestedIds.length > 0
      ? await rootDb.transaction(async (tx) => {
          const transitioned = await tx
            .update(aiMemories)
            .set({ status: "archived", archivedAt: new Date(now) })
            .where(
              and(
                eq(aiMemories.status, "suggested"),
                eq(aiMemories.pinned, false),
                lt(aiMemories.createdAt, suggestionCutoff),
                inArray(
                  aiMemories.id,
                  suggestedIds.map(({ id }) => id),
                ),
              ),
            )
            .returning(memoryLifecycleReturning);
          await recordMemoryLifecycleAuditEvents(tx, transitioned, {
            oldStatus: "suggested",
            newStatus: "archived",
          });
          return transitioned;
        })
      : [];

  logger.info("scheduler.memory_curator", {
    "memory.staled": staled.length,
    "memory.archived": archived.length,
    "memory.suggestions_archived": archivedSuggestions.length,
  });
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
