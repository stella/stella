import { panic } from "better-result";
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
import { sql } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import {
  brandPersistedChatThreadId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

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

/**
 * How a claimed thread leaves the queue.
 *
 *  - "drained": nothing left to fold in; the thread leaves the queue until a
 *    send re-enqueues it.
 *  - "requeued": the run made progress and the thread is still behind, or the
 *    chain moved underneath it and the next run should look again. Due
 *    immediately, and the attempt counter resets because progress is not a
 *    failure.
 *  - "failed": the run produced no checkpoint. Due again only after a capped
 *    exponential backoff, so a thread that fails deterministically cannot
 *    consume a claim slot and a provider call on every tick.
 *
 * A discriminator rather than a boolean: "still has work" and "could not do the
 * work" need different schedules, and collapsing them is what made a failing
 * thread retry at full rate.
 */
export const CHAT_COMPACTION_SETTLEMENTS = [
  "drained",
  "requeued",
  "failed",
] as const;
export type ChatCompactionSettlement =
  (typeof CHAT_COMPACTION_SETTLEMENTS)[number];
export const CHAT_COMPACTION_SETTLEMENT = {
  DRAINED: "drained",
  REQUEUED: "requeued",
  FAILED: "failed",
} as const satisfies Record<string, ChatCompactionSettlement>;

/**
 * Backoff bounds for a failing thread, mirroring the search-projection repair
 * queue: first retry a minute out, doubling per consecutive failure, capped so
 * a thread never falls out of the queue entirely.
 */
const COMPACTION_RETRY_BASE_SECONDS = 60;
const COMPACTION_RETRY_MAX_SECONDS = 6 * 60 * 60;

type BuildSettleChatCompactionQueueQueryOptions = {
  leaseExpiresAt: Date;
  now: Date;
  settlement: ChatCompactionSettlement;
  threadId: SafeId<"chatThread">;
};

/**
 * Release one claimed thread with compare-and-set semantics.
 *
 * The settlement comes from the run itself — it read one row past its batch and
 * knows whether the thread is still behind — so the queue never re-derives
 * due-ness with a second scan. The `compaction_scheduled_at = lease` guard is
 * what makes a concurrent send's wakeup survive: it changed the token, so this
 * settlement matches nothing and the thread stays due.
 *
 * The backoff is computed from the stored attempt count inside the statement,
 * so consecutive failures compound without the caller tracking anything.
 */
export const buildSettleChatCompactionQueueQuery = ({
  leaseExpiresAt,
  now,
  settlement,
  threadId,
}: BuildSettleChatCompactionQueueQueryOptions) => sql`
  UPDATE chat_threads AS thread
  SET
    compaction_scheduled_at = ${scheduledAtForSettlement(settlement, now)},
    compaction_attempts = ${settlement === CHAT_COMPACTION_SETTLEMENT.FAILED ? sql`thread.compaction_attempts + 1` : sql`0`},
    compaction_attempted_at = ${now}
  WHERE thread.id = ${threadId}
    AND thread.compaction_scheduled_at = ${leaseExpiresAt}::timestamptz
`;

const scheduledAtForSettlement = (
  settlement: ChatCompactionSettlement,
  now: Date,
) => {
  switch (settlement) {
    case "drained": {
      return sql`null`;
    }
    case "requeued": {
      return sql`${now}`;
    }
    case "failed": {
      return sql`${now}::timestamptz + make_interval(secs => LEAST(
        ${COMPACTION_RETRY_BASE_SECONDS}::double precision
          * power(2, thread.compaction_attempts),
        ${COMPACTION_RETRY_MAX_SECONDS}::double precision
      ))`;
    }
    default: {
      settlement satisfies never;
      return panic(`Unhandled settlement: ${String(settlement)}`);
    }
  }
};

export type ParsedChatCompactionQueue = {
  /** Rows that could not be read, kept as a count for telemetry. */
  malformedRowCount: number;
  threads: QueuedCompactionThread[];
};

/**
 * Read the claimed rows, skipping any the schema says cannot happen.
 *
 * Deliberately not a panic: the claim has already written the lease by the time
 * this runs, so aborting the batch would strand every other claimed thread for
 * the full lease duration over one unreadable row. Skipping costs that one
 * thread its lease window and lets the rest proceed. The count is returned so
 * the caller can report a shape the schema forbids rather than silently
 * dropping work.
 */
export const parseChatCompactionQueueRows = (
  rows: readonly unknown[],
): ParsedChatCompactionQueue => {
  const threads: QueuedCompactionThread[] = [];
  let malformedRowCount = 0;

  for (const row of rows) {
    const parsed = parseChatCompactionQueueRow(row);
    if (parsed === null) {
      malformedRowCount += 1;
      continue;
    }
    threads.push(parsed);
  }

  return { malformedRowCount, threads };
};

const parseChatCompactionQueueRow = (
  value: unknown,
): QueuedCompactionThread | null => {
  if (!isRecord(value)) {
    return null;
  }

  const { chatModel, dataWorkspaceIds, organizationId, threadId, userId } =
    value;
  if (
    typeof threadId !== "string" ||
    typeof organizationId !== "string" ||
    typeof userId !== "string"
  ) {
    return null;
  }

  // A thread with no model override is the common case, so null is valid here
  // while the identifiers above are not.
  if (chatModel !== null && typeof chatModel !== "string") {
    return null;
  }

  if (
    !isUnknownArray(dataWorkspaceIds) ||
    !dataWorkspaceIds.every((id) => typeof id === "string")
  ) {
    return null;
  }

  return {
    chatModel,
    dataWorkspaceIds: dataWorkspaceIds.map(brandPersistedWorkspaceId),
    organizationId: brandPersistedOrganizationId(organizationId),
    threadId: brandPersistedChatThreadId(threadId),
    userId: brandPersistedUserId(userId),
  };
};
