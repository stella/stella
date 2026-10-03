import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreadCompactions,
  chatThreads,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toPersistableChatMessage } from "@/api/handlers/chat/chat-message-parts";
import type { MessagePersistencePlan } from "@/api/handlers/chat/persist-message";
import { reconcileChatCompactionChainOnTx } from "@/api/handlers/chat/persistent-compaction";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { seedActiveChatCompaction } from "@/api/tests/helpers/chat-compaction-checkpoint";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// What one history write does to a thread's compaction chain, against PGlite:
// the checkpoint survives every write that leaves the history it summarizes
// untouched, and the epoch moves on every write that changes a stored row.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

/** m0..m3, alternating user and assistant; the checkpoint, when there is one,
 *  summarizes m0..m1 and keeps m2 onward. */
type SeededThread = {
  messages: Record<"m0" | "m1" | "m2" | "m3", SafeId<"chatMessage">>;
  threadId: SafeId<"chatThread">;
};

type CheckpointSeed = "absent" | "boundary-row" | "legacy-no-cursor";

const seedThread = async ({
  checkpoint,
  boundarySharesMillisecond,
}: {
  checkpoint: CheckpointSeed;
  /** Store m1 and m2 in the same millisecond, ordered only by id. */
  boundarySharesMillisecond: boolean;
}): Promise<SeededThread> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Compaction chain test thread",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  const messageIds = Array.from({ length: 4 }, () =>
    toSafeId<"chatMessage">(Bun.randomUUIDv7()),
  ).toSorted();
  const [m0, m1, m2, m3] = messageIds;
  if (!m0 || !m1 || !m2 || !m3) {
    return panic("seeded four message ids");
  }
  const base = Date.parse("2026-05-01T00:00:00.000Z");
  const offsets = boundarySharesMillisecond ? [0, 1, 1, 2] : [0, 1, 2, 3];
  await testDb.insert(chatMessages).values(
    messageIds.map((id, index) => ({
      content: {
        version: 1 as const,
        data: [{ type: "text" as const, text: `message ${index}` }],
      },
      createdAt: new Date(base + (offsets[index] ?? panic("offset"))),
      id,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    })),
  );
  if (checkpoint !== "absent") {
    await seedActiveChatCompaction({
      cursor: checkpoint === "legacy-no-cursor" ? "none" : "boundary-row",
      firstKeptMessageId: m2,
      firstSummarizedMessageId: m0,
      lastSummarizedMessageId: m1,
      summarizedMessageCount: 2,
      testDb,
      threadId,
    });
  }
  return { messages: { m0, m1, m2, m3 }, threadId };
};

const readChain = async (threadId: SafeId<"chatThread">) => {
  const thread = await testDb
    .select({ epoch: chatThreads.compactionEpoch })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId));
  const checkpoints = await testDb
    .select({ status: chatThreadCompactions.status })
    .from(chatThreadCompactions)
    .where(eq(chatThreadCompactions.threadId, threadId));
  return {
    checkpoint: checkpoints.at(0)?.status ?? "absent",
    epoch: thread.at(0)?.epoch ?? panic("seeded thread"),
  };
};

const updateOf = (
  messageId: SafeId<"chatMessage">,
): MessagePersistencePlan => ({
  message: toPersistableChatMessage({
    id: messageId,
    parts: [{ content: "rewritten", type: "text" }],
    role: "assistant",
  }),
  messageId,
  type: "update",
});

type ChainCase = {
  boundarySharesMillisecond?: boolean;
  checkpoint: CheckpointSeed;
  expected: {
    checkpoint: "absent" | "active" | "stale";
    epochAdvanced: boolean;
  };
  name: string;
  write: (messages: SeededThread["messages"]) => {
    deletedMessageIds: readonly SafeId<"chatMessage">[];
    persistencePlan: MessagePersistencePlan;
  };
};

const CHAIN_CASES: readonly ChainCase[] = [
  {
    name: "an appended message leaves the chain as it is",
    checkpoint: "boundary-row",
    write: () => ({
      deletedMessageIds: [],
      persistencePlan: {
        message: toPersistableChatMessage({
          id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
          parts: [{ content: "appended", type: "text" }],
          role: "user",
        }),
        type: "insert",
      },
    }),
    expected: { checkpoint: "active", epochAdvanced: false },
  },
  {
    name: "a write that stores nothing leaves the chain as it is",
    checkpoint: "boundary-row",
    write: () => ({ deletedMessageIds: [], persistencePlan: { type: "none" } }),
    expected: { checkpoint: "active", epochAdvanced: false },
  },
  {
    name: "rewriting the newest kept message keeps the summary",
    checkpoint: "boundary-row",
    write: ({ m3 }) => ({
      deletedMessageIds: [],
      persistencePlan: updateOf(m3),
    }),
    expected: { checkpoint: "active", epochAdvanced: true },
  },
  {
    name: "rewriting the first kept message keeps the summary",
    checkpoint: "boundary-row",
    write: ({ m2 }) => ({
      deletedMessageIds: [],
      persistencePlan: updateOf(m2),
    }),
    expected: { checkpoint: "active", epochAdvanced: true },
  },
  {
    name: "rewriting the first kept message in the boundary's millisecond keeps the summary",
    boundarySharesMillisecond: true,
    checkpoint: "boundary-row",
    write: ({ m2 }) => ({
      deletedMessageIds: [],
      persistencePlan: updateOf(m2),
    }),
    expected: { checkpoint: "active", epochAdvanced: true },
  },
  {
    name: "rewriting the boundary message in its own millisecond retires the summary",
    boundarySharesMillisecond: true,
    checkpoint: "boundary-row",
    write: ({ m1 }) => ({
      deletedMessageIds: [],
      persistencePlan: updateOf(m1),
    }),
    expected: { checkpoint: "stale", epochAdvanced: true },
  },
  {
    name: "rewriting a summarized message retires the summary",
    checkpoint: "boundary-row",
    write: ({ m0 }) => ({
      deletedMessageIds: [],
      persistencePlan: updateOf(m0),
    }),
    expected: { checkpoint: "stale", epochAdvanced: true },
  },
  {
    name: "a chain with no cursor cannot prove a rewrite is outside it",
    checkpoint: "legacy-no-cursor",
    write: ({ m3 }) => ({
      deletedMessageIds: [],
      persistencePlan: updateOf(m3),
    }),
    expected: { checkpoint: "stale", epochAdvanced: true },
  },
  {
    name: "a rewrite of a thread with no checkpoint still moves the epoch",
    checkpoint: "absent",
    write: ({ m3 }) => ({
      deletedMessageIds: [],
      persistencePlan: updateOf(m3),
    }),
    expected: { checkpoint: "absent", epochAdvanced: true },
  },
  {
    name: "a truncating rewrite retires the summary",
    checkpoint: "boundary-row",
    write: ({ m2, m3 }) => ({
      deletedMessageIds: [m3],
      persistencePlan: updateOf(m2),
    }),
    expected: { checkpoint: "stale", epochAdvanced: true },
  },
  {
    name: "replacing the last assistant message retires the summary",
    checkpoint: "boundary-row",
    write: ({ m3 }) => ({
      deletedMessageIds: [m3],
      persistencePlan: {
        deleteMessageId: m3,
        insertMessage: toPersistableChatMessage({
          id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
          parts: [{ content: "replacement", type: "text" }],
          role: "assistant",
        }),
        type: "replace-last-assistant",
      },
    }),
    expected: { checkpoint: "stale", epochAdvanced: true },
  },
];

const PLAN_TYPES = {
  insert: true,
  none: true,
  "replace-last-assistant": true,
  update: true,
} as const satisfies Record<MessagePersistencePlan["type"], true>;

describe("a history write's effect on the compaction chain", () => {
  test("every persistence plan has a case", () => {
    const messageId = () => toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const messages = {
      m0: messageId(),
      m1: messageId(),
      m2: messageId(),
      m3: messageId(),
    };
    const exercised = new Set(
      CHAIN_CASES.map(
        (chainCase) => chainCase.write(messages).persistencePlan.type,
      ),
    );
    expect(Object.keys(PLAN_TYPES).toSorted()).toEqual(
      [...exercised].toSorted(),
    );
  });

  test.each(CHAIN_CASES.map((chainCase) => [chainCase.name, chainCase]))(
    "%s",
    async (_name, chainCase) => {
      const seeded = await seedThread({
        boundarySharesMillisecond: chainCase.boundarySharesMillisecond ?? false,
        checkpoint: chainCase.checkpoint,
      });
      const before = await readChain(seeded.threadId);
      expect(before.checkpoint).toBe(
        chainCase.checkpoint === "absent" ? "absent" : "active",
      );

      const written = await safeDb(
        async (tx) =>
          await reconcileChatCompactionChainOnTx({
            ...chainCase.write(seeded.messages),
            threadId: seeded.threadId,
            tx,
          }),
      );
      expect(Result.isOk(written)).toBe(true);

      const after = await readChain(seeded.threadId);
      expect(after).toEqual({
        checkpoint: chainCase.expected.checkpoint,
        epoch: before.epoch + (chainCase.expected.epochAdvanced ? 1 : 0),
      });
    },
  );
});
