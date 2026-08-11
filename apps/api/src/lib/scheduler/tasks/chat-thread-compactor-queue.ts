/**
 * Claim/settle SQL for the chat-thread compaction queue.
 *
 * `chat_threads.compaction_scheduled_at` doubles as the queue address and the
 * lease token, mirroring the memory extractor's tenant queue: a due thread
 * carries a wall-clock stamp, a claimed thread carries its claim's expiry, and
 * settlement is a compare-and-set against that expiry. A send that marks the
 * thread due while a run is in flight overwrites the token, so the stale
 * settlement no-ops instead of erasing the wakeup.
 */
import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import {
  brandPersistedChatThreadId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

/**
 * Threads one run may claim. Each claimed thread costs one bounded delta read
 * plus one summarization call, so this is the run's real concurrency budget.
 */
export const CHAT_COMPACTION_THREAD_BATCH_SIZE = 10;
/**
 * How long a claim holds a thread. Long enough to cover a slow provider call,
 * short enough that a crashed run's threads return to the queue within an hour.
 */
export const CHAT_COMPACTION_QUEUE_LEASE_MS = 15 * 60_000;

export type QueuedCompactionThread = {
  chatModel: string | null;
  dataWorkspaceIds: SafeId<"workspace">[];
  organizationId: SafeId<"organization">;
  threadId: SafeId<"chatThread">;
  /** Thread owner. The compactor reads under this user's RLS scope, never a
   *  wider one, even though it claims work across every tenant. */
  userId: SafeId<"user">;
};

type CompactionQueueRow = QueuedCompactionThread;

type BuildClaimChatCompactionQueueQueryOptions = {
  leaseExpiresAt: Date;
  now: Date;
};

/**
 * Claim a bounded page of due threads.
 *
 * `SKIP LOCKED` lets several API instances drain the queue at once without
 * blocking on each other. Ordering by the schedule stamp then the last attempt
 * keeps never-attempted work ahead of work that has already failed, so one
 * permanently failing thread cannot hold its slot indefinitely.
 *
 * Anonymized threads are excluded: their content never reaches a third-party
 * summarizer, so they intentionally never form a checkpoint.
 */
export const buildClaimChatCompactionQueueQuery = ({
  leaseExpiresAt,
  now,
}: BuildClaimChatCompactionQueueQueryOptions) => sql<CompactionQueueRow>`
  WITH due_threads AS MATERIALIZED (
    SELECT thread.id
    FROM chat_threads AS thread
    WHERE thread.compaction_scheduled_at IS NOT NULL
      AND thread.compaction_scheduled_at <= ${now}::timestamptz
      AND thread.used_anonymization = false
    ORDER BY
      thread.compaction_scheduled_at,
      thread.compaction_attempted_at ASC NULLS FIRST,
      thread.id
    LIMIT ${CHAT_COMPACTION_THREAD_BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  ),
  claimed_threads AS (
    UPDATE chat_threads AS thread
    SET compaction_scheduled_at = ${leaseExpiresAt}
    FROM due_threads AS due
    WHERE thread.id = due.id
    RETURNING
      thread.id,
      thread.organization_id,
      thread.user_id,
      thread.chat_model,
      thread.data_workspace_ids
  )
  SELECT
    claimed.id AS "threadId",
    claimed.organization_id AS "organizationId",
    claimed.user_id AS "userId",
    claimed.chat_model AS "chatModel",
    claimed.data_workspace_ids AS "dataWorkspaceIds"
  FROM claimed_threads AS claimed
`;

type BuildSettleChatCompactionQueueQueryOptions = {
  leaseExpiresAt: Date;
  /** Whether the thread still has delta the compactor has not folded in. */
  hasMoreWork: boolean;
  now: Date;
  threadId: SafeId<"chatThread">;
};

/**
 * Release one claimed thread with compare-and-set semantics.
 *
 * `hasMoreWork` comes from the run itself — it read one row past its batch and
 * knows whether the thread is still behind — so the queue never re-derives
 * due-ness with a second scan. The `compaction_scheduled_at = lease` guard is
 * what makes a concurrent send's wakeup survive: it changed the token, so this
 * settlement matches nothing and the thread stays due.
 */
export const buildSettleChatCompactionQueueQuery = ({
  hasMoreWork,
  leaseExpiresAt,
  now,
  threadId,
}: BuildSettleChatCompactionQueueQueryOptions) => sql`
  UPDATE chat_threads AS thread
  SET
    compaction_scheduled_at = ${hasMoreWork ? now : null},
    compaction_attempted_at = ${now}
  WHERE thread.id = ${threadId}
    AND thread.compaction_scheduled_at = ${leaseExpiresAt}::timestamptz
`;

export const parseChatCompactionQueueRows = (
  rows: readonly unknown[],
): QueuedCompactionThread[] => rows.map(parseChatCompactionQueueRow);

const parseChatCompactionQueueRow = (
  value: unknown,
): QueuedCompactionThread => {
  if (typeof value !== "object" || value === null) {
    return panic("Chat compaction queue returned an invalid row");
  }

  const threadId = "threadId" in value ? value.threadId : undefined;
  const organizationId =
    "organizationId" in value ? value.organizationId : undefined;
  const userId = "userId" in value ? value.userId : undefined;
  if (
    typeof threadId !== "string" ||
    typeof organizationId !== "string" ||
    typeof userId !== "string"
  ) {
    return panic("Chat compaction queue returned invalid thread metadata");
  }

  const chatModel = "chatModel" in value ? value.chatModel : null;
  if (chatModel !== null && typeof chatModel !== "string") {
    return panic("Chat compaction queue returned an invalid chat model");
  }

  const dataWorkspaceIds =
    "dataWorkspaceIds" in value ? value.dataWorkspaceIds : [];
  if (
    !Array.isArray(dataWorkspaceIds) ||
    !dataWorkspaceIds.every((id) => typeof id === "string")
  ) {
    return panic("Chat compaction queue returned invalid workspace ids");
  }

  return {
    chatModel,
    dataWorkspaceIds: dataWorkspaceIds.map(brandPersistedWorkspaceId),
    organizationId: brandPersistedOrganizationId(organizationId),
    threadId: brandPersistedChatThreadId(threadId),
    userId: brandPersistedUserId(userId),
  };
};
