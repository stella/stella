import { panic } from "better-result";
import { and, eq, lt } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { aiMemories } from "@/api/db/schema";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const MEMORY_CURATOR_TASK = "memory.curator" as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Unpinned active memories nobody has used in this window go stale; stale
// ones untouched for the longer window are archived. Never hard-deleted.
const STALE_AFTER_DAYS = 30;
const ARCHIVE_AFTER_DAYS = 90;

/**
 * Lifecycle sweep for AI memories: active -> stale -> archived, driven by
 * `lastUsedAt`. Pinned memories are exempt at every step. Runs on the root
 * connection (RLS-bypassing), so it operates across every tenant; scoping
 * is by status/pinned/lastUsedAt only, which is correct for a global
 * maintenance pass that never reads tenant content.
 */
export const curateAiMemories: SchedulerTask = async ({ logger, signal }) => {
  const now = Date.now();
  const staleCutoff = new Date(now - STALE_AFTER_DAYS * MS_PER_DAY);
  const archiveCutoff = new Date(now - ARCHIVE_AFTER_DAYS * MS_PER_DAY);

  const staled = await rootDb
    .update(aiMemories)
    .set({ status: "stale" })
    .where(
      and(
        eq(aiMemories.status, "active"),
        eq(aiMemories.pinned, false),
        lt(aiMemories.lastUsedAt, staleCutoff),
      ),
    )
    .returning({ id: aiMemories.id });

  if (signal.aborted) {
    panic("SchedulerAborted");
  }

  const archived = await rootDb
    .update(aiMemories)
    .set({ status: "archived", archivedAt: new Date() })
    .where(
      and(
        eq(aiMemories.status, "stale"),
        eq(aiMemories.pinned, false),
        lt(aiMemories.lastUsedAt, archiveCutoff),
      ),
    )
    .returning({ id: aiMemories.id });

  logger.info("scheduler.memory_curator", {
    "memory.staled": staled.length,
    "memory.archived": archived.length,
  });

  if (signal.aborted) {
    panic("SchedulerAborted");
  }
};
