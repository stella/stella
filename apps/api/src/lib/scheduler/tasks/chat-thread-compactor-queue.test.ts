import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";

import {
  buildClaimChatCompactionQueueQuery,
  buildSettleChatCompactionQueueQuery,
  CHAT_COMPACTION_THREAD_BATCH_SIZE,
  parseChatCompactionQueueRows,
} from "./chat-thread-compactor-queue";

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

  test("compare-and-sets on the lease so a concurrent wakeup survives", () => {
    const query = dialect.sqlToQuery(
      buildSettleChatCompactionQueueQuery({
        hasMoreWork: false,
        leaseExpiresAt,
        now,
        threadId,
      }),
    );

    // A send that marks the thread due mid-run overwrites the lease token.
    // This guard is what makes the stale settlement match no rows instead of
    // clearing that wakeup.
    expect(query.sql).toContain("thread.compaction_scheduled_at = $");
    expect(query.params).toContain(leaseExpiresAt);
  });

  test("drains a finished thread and requeues one that is still behind", () => {
    const drained = dialect.sqlToQuery(
      buildSettleChatCompactionQueueQuery({
        hasMoreWork: false,
        leaseExpiresAt,
        now,
        threadId,
      }),
    );
    const requeued = dialect.sqlToQuery(
      buildSettleChatCompactionQueueQuery({
        hasMoreWork: true,
        leaseExpiresAt,
        now,
        threadId,
      }),
    );

    expect(drained.params).toContain(null);
    expect(requeued.params).toContain(now);
    // Both stamp the attempt, so a repeatedly failing thread rotates behind
    // untouched work rather than holding the head of the queue.
    expect(drained.sql).toContain("compaction_attempted_at = $");
    expect(requeued.sql).toContain("compaction_attempted_at = $");
  });
});

describe("chat compaction queue row parsing", () => {
  test("carries the thread's own tenant, owner and matter scope", () => {
    const threadId = Bun.randomUUIDv7();
    const workspaceId = Bun.randomUUIDv7();

    const [parsed] = parseChatCompactionQueueRows([
      {
        chatModel: "anthropic::claude-sonnet-4",
        dataWorkspaceIds: [workspaceId],
        organizationId: "org_abc",
        threadId,
        userId: "user_abc",
      },
    ]);

    expect(parsed).toEqual({
      chatModel: "anthropic::claude-sonnet-4",
      dataWorkspaceIds: [toSafeId<"workspace">(workspaceId)],
      organizationId: toSafeId<"organization">("org_abc"),
      threadId: toSafeId<"chatThread">(threadId),
      userId: toSafeId<"user">("user_abc"),
    });
  });

  test("panics rather than compacting a thread whose owner is unknown", () => {
    // A missing owner would otherwise silently widen the scoped read the
    // compactor runs under.
    expect(() =>
      parseChatCompactionQueueRows([
        {
          chatModel: null,
          dataWorkspaceIds: [],
          organizationId: "org_abc",
          threadId: Bun.randomUUIDv7(),
        },
      ]),
    ).toThrow();
  });

  test("panics on a non-array matter scope", () => {
    expect(() =>
      parseChatCompactionQueueRows([
        {
          chatModel: null,
          dataWorkspaceIds: "not-an-array",
          organizationId: "org_abc",
          threadId: Bun.randomUUIDv7(),
          userId: "user_abc",
        },
      ]),
    ).toThrow();
  });
});
