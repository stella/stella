import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";

import {
  buildClaimChatCompactionQueueQuery,
  buildSettleChatCompactionQueueQuery,
  CHAT_COMPACTION_SETTLEMENT,
  CHAT_COMPACTION_SETTLEMENTS,
  CHAT_COMPACTION_THREAD_BATCH_SIZE,
  parseChatCompactionQueueRows,
} from "./chat-thread-compactor-queue";
import type { ChatCompactionSettlement } from "./chat-thread-compactor-queue";

const dialect = new PgDialect();

const leaseExpiresAt = new Date("2026-08-11T00:15:00.000Z");
const now = new Date("2026-08-11T00:00:00.000Z");

describe("chat compaction queue claim", () => {
  test("bounds and locks the claim so concurrent runners cannot take the same thread", () => {
    const query = dialect.sqlToQuery(
      buildClaimChatCompactionQueueQuery({ leaseExpiresAt, now }),
    );

    expect(query.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(query.sql).toContain(
      `LIMIT $${query.params.indexOf(CHAT_COMPACTION_THREAD_BATCH_SIZE) + 1}`,
    );
    // The lease replaces the queue stamp, so a claimed thread is invisible to
    // the next claim until it is settled or the lease is overwritten.
    expect(query.sql).toContain("SET compaction_scheduled_at = $");
    expect(query.params).toContain(leaseExpiresAt);
  });

  test("orders never-attempted work ahead of previously failed work", () => {
    const { sql } = dialect.sqlToQuery(
      buildClaimChatCompactionQueueQuery({ leaseExpiresAt, now }),
    );

    const scheduledAt = sql.indexOf("thread.compaction_scheduled_at,");
    const attemptedAt = sql.indexOf(
      "thread.compaction_attempted_at ASC NULLS FIRST",
    );
    const tieBreak = sql.indexOf("thread.id\n", attemptedAt);

    expect(scheduledAt).toBeGreaterThan(-1);
    expect(attemptedAt).toBeGreaterThan(scheduledAt);
    expect(tieBreak).toBeGreaterThan(attemptedAt);
  });

  test("never claims an anonymized thread", () => {
    const { sql } = dialect.sqlToQuery(
      buildClaimChatCompactionQueueQuery({ leaseExpiresAt, now }),
    );

    // Anonymized threads must not reach a third-party summarizer, so they
    // deliberately never form a checkpoint.
    expect(sql).toContain("thread.used_anonymization = false");
  });
});

describe("chat compaction queue settlement", () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());

  const settle = (settlement: ChatCompactionSettlement) =>
    dialect.sqlToQuery(
      buildSettleChatCompactionQueueQuery({
        leaseExpiresAt,
        now,
        settlement,
        threadId,
      }),
    );

  test("compare-and-sets on the lease so a concurrent wakeup survives", () => {
    // A send that marks the thread due mid-run overwrites the lease token.
    // This guard is what makes the stale settlement match no rows instead of
    // clearing that wakeup.
    for (const settlement of CHAT_COMPACTION_SETTLEMENTS) {
      const query = settle(settlement);
      expect(query.sql).toContain("thread.compaction_scheduled_at = $");
      expect(query.params).toContain(leaseExpiresAt);
    }
  });

  test("only a drained thread clears its queue address", () => {
    // Asserted in both directions: `now` is bound for the attempt stamp by
    // every settlement, so containment alone would hold for all three and
    // prove nothing about the schedule each one writes.
    const drained = settle(CHAT_COMPACTION_SETTLEMENT.DRAINED);
    const requeued = settle(CHAT_COMPACTION_SETTLEMENT.REQUEUED);
    const failed = settle(CHAT_COMPACTION_SETTLEMENT.FAILED);

    expect(drained.sql).toContain("compaction_scheduled_at = null");
    expect(requeued.sql).not.toContain("compaction_scheduled_at = null");
    expect(failed.sql).not.toContain("compaction_scheduled_at = null");
  });

  test("a requeued thread comes due immediately and a failed one backs off", () => {
    const requeued = settle(CHAT_COMPACTION_SETTLEMENT.REQUEUED);
    const failed = settle(CHAT_COMPACTION_SETTLEMENT.FAILED);

    // Progress goes straight back on the queue.
    expect(requeued.sql).not.toContain("make_interval");
    // A failure is delayed by a capped doubling of the stored attempt count,
    // so a thread that fails every run cannot be re-claimed every tick.
    expect(failed.sql).toContain("make_interval");
    expect(failed.sql).toContain("power(2, thread.compaction_attempts)");
    expect(failed.sql).toContain("LEAST");
  });

  test("only a failure advances the attempt count; progress resets it", () => {
    // The counter is what the backoff compounds on, so a run that made
    // progress has to clear it or the next failure would start pre-delayed.
    expect(settle(CHAT_COMPACTION_SETTLEMENT.FAILED).sql).toContain(
      "compaction_attempts = thread.compaction_attempts + 1",
    );
    expect(settle(CHAT_COMPACTION_SETTLEMENT.DRAINED).sql).toContain(
      "compaction_attempts = 0",
    );
    expect(settle(CHAT_COMPACTION_SETTLEMENT.REQUEUED).sql).toContain(
      "compaction_attempts = 0",
    );
  });

  test("every settlement stamps the attempt time", () => {
    // Declared set equals exercised set: a new settlement value cannot land
    // without deciding what it writes.
    for (const settlement of CHAT_COMPACTION_SETTLEMENTS) {
      expect(settle(settlement).sql).toContain("compaction_attempted_at = $");
    }
  });
});

describe("chat compaction queue row parsing", () => {
  const claimedRow = () => ({
    chatModel: "anthropic::claude-sonnet-4",
    dataWorkspaceIds: [Bun.randomUUIDv7()],
    organizationId: Bun.randomUUIDv7(),
    threadId: Bun.randomUUIDv7(),
    userId: Bun.randomUUIDv7(),
  });

  test("carries the thread's own tenant, owner and matter scope", () => {
    const row = claimedRow();

    const { malformedRowCount, threads } = parseChatCompactionQueueRows([row]);

    expect(malformedRowCount).toBe(0);
    expect(threads).toEqual([
      {
        chatModel: row.chatModel,
        dataWorkspaceIds: row.dataWorkspaceIds.map((id) =>
          toSafeId<"workspace">(id),
        ),
        organizationId: toSafeId<"organization">(row.organizationId),
        threadId: toSafeId<"chatThread">(row.threadId),
        userId: toSafeId<"user">(row.userId),
      },
    ]);
  });

  test("accepts a thread with no model override", () => {
    const { malformedRowCount, threads } = parseChatCompactionQueueRows([
      { ...claimedRow(), chatModel: null },
    ]);

    expect(malformedRowCount).toBe(0);
    expect(threads.at(0)?.chatModel).toBeNull();
  });

  test("skips a row whose owner is unknown rather than dropping the batch", () => {
    // A missing owner would otherwise widen the scoped read the compactor runs
    // under. Skipping rather than throwing matters because the claim has
    // already written the lease: aborting here would strand every valid thread
    // in the same batch until that lease expired.
    const { userId: _omitted, ...withoutOwner } = claimedRow();
    const valid = claimedRow();

    const { malformedRowCount, threads } = parseChatCompactionQueueRows([
      withoutOwner,
      valid,
    ]);

    expect(malformedRowCount).toBe(1);
    expect(threads.map(({ threadId }) => threadId)).toEqual([
      toSafeId<"chatThread">(valid.threadId),
    ]);
  });

  test("skips a row with a non-array matter scope", () => {
    const { malformedRowCount, threads } = parseChatCompactionQueueRows([
      { ...claimedRow(), dataWorkspaceIds: "not-an-array" },
    ]);

    expect(malformedRowCount).toBe(1);
    expect(threads).toEqual([]);
  });

  test("skips a row that is not an object at all", () => {
    const { malformedRowCount, threads } = parseChatCompactionQueueRows([
      null,
      "nonsense",
    ]);

    expect(malformedRowCount).toBe(2);
    expect(threads).toEqual([]);
  });
});
