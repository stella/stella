import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db";
import {
  chatMessages,
  chatThreadCompactions,
  chatThreads,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { shouldCompactChatMessages } from "@/api/handlers/chat/compaction";
import type { WindowedThreadMessage } from "@/api/handlers/chat/history-window";
import {
  chatMessageExistsForThread,
  loadWindowedThreadMessages,
  resolveTruncationTarget,
} from "@/api/handlers/chat/history-window";
import type { ChatCompactionSummary } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Exercises the windowed message loader, the truncation-target resolver, and
// the incoming-message existence check against PGlite. The loader and resolver
// compare the full-precision (createdAt, id) tuple in-DB, so rows sharing a
// millisecond are neither skipped at the checkpoint boundary nor dropped from
// a retained replay prefix. shouldCompactChatMessages is a pure token gate, so
// it is asserted directly.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  // A real RLS-scoped query over the test DB, presented as the SafeDb the
  // helpers expect. The scoped query runs over PGlite, whose transaction type
  // differs from production only in the query-result driver (erased at
  // runtime), so it is cast to the production ScopedDb shape.
  const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  safeDb = toSafeDbMock(asTestRaw<ScopedDb>(scoped));
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    // Cascade removes the seeded messages and compaction rows.
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

type SeededMessage = {
  id: SafeId<"chatMessage">;
  createdAt: Date;
  text: string;
};

const seedThread = async (
  specs: { createdAt: Date; text: string }[],
): Promise<{ threadId: SafeId<"chatThread">; messages: SeededMessage[] }> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "History window test thread",
    workspaceId: ids.wsA1,
  });
  seededThreadIds.push(threadId);

  const rows = specs.map((spec, index) => ({
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: {
      version: 1 as const,
      data: [{ type: "text" as const, text: spec.text }],
    },
    createdAt: spec.createdAt,
  }));
  if (rows.length > 0) {
    await testDb.insert(chatMessages).values(rows);
  }

  return {
    threadId,
    messages: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      text: row.content.data[0]?.text ?? "",
    })),
  };
};

const emptySummary: ChatCompactionSummary = {
  version: 1,
  blocked: [],
  constraints: [],
  criticalContext: [],
  done: [],
  goal: "Continue the matter.",
  inProgress: [],
  keyDecisions: [],
  modifiedFiles: [],
  nextSteps: [],
  readFiles: [],
};

const seedActiveCheckpoint = async ({
  threadId,
  firstSummarizedMessageId,
  lastSummarizedMessageId,
  firstKeptMessageId,
  summarizedMessageCount,
}: {
  threadId: SafeId<"chatThread">;
  firstSummarizedMessageId: SafeId<"chatMessage">;
  lastSummarizedMessageId: SafeId<"chatMessage">;
  firstKeptMessageId: SafeId<"chatMessage">;
  summarizedMessageCount: number;
}): Promise<void> => {
  await testDb.insert(chatThreadCompactions).values({
    id: toSafeId<"chatThreadCompaction">(Bun.randomUUIDv7()),
    threadId,
    status: "active",
    summary: emptySummary,
    summaryMarkdown: "## Goal\nContinue the matter.",
    firstSummarizedMessageId,
    lastSummarizedMessageId,
    firstKeptMessageId,
    summarizedMessageCount,
    totalTokens: 70_000,
    preservedTokens: 30_000,
    promptVersion: 1,
  });
};

const unwrap = <T>(result: Result<T, { message: string }>): T => {
  if (Result.isError(result)) {
    throw new TypeError(`helper failed: ${result.error.message}`);
  }
  return result.value;
};

// Roughly 5 chars per repeat / 4 chars per token => ~100k tokens, safely past
// the 64k DEFAULT_TRIGGER_TOKENS used by shouldCompactChatMessages.
const longText = (token: string): string => `${token} `.repeat(80_000);

const windowTexts = (window: WindowedThreadMessage[]): (string | null)[] =>
  window.map((message) => {
    const part = message.content.data.at(0);
    return part?.type === "text" ? part.text : null;
  });

// Postgres uuid order equals lexicographic order of the canonical string, so
// for same-millisecond rows the DB's (createdAt, id) order matches sorting by
// id in JS.
const byId = (a: SeededMessage, b: SeededMessage): number => {
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
};

describe("loadWindowedThreadMessages", () => {
  test("loads the full history ascending when no checkpoint exists", async () => {
    const base = Date.parse("2026-02-01T00:00:00.000Z");
    const { threadId, messages } = await seedThread(
      Array.from({ length: 5 }, (_, i) => ({
        createdAt: new Date(base + i),
        text: `m${i}`,
      })),
    );

    const window = unwrap(
      await loadWindowedThreadMessages({ safeDb, threadId }),
    );

    expect(window.map((m) => m.id)).toEqual(messages.map((m) => m.id));
    expect(windowTexts(window)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  test("loads only [firstKept..now] when a checkpoint excludes an old prefix", async () => {
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    const { threadId, messages } = await seedThread(
      Array.from({ length: 6 }, (_, i) => ({
        createdAt: new Date(base + i),
        text: `m${i}`,
      })),
    );
    // Summarize m0..m2; keep from m3 onward.
    const [m0, , m2, m3, m4, m5] = messages;
    if (!m0 || !m2 || !m3 || !m4 || !m5) {
      throw new Error("seed precondition failed");
    }
    await seedActiveCheckpoint({
      threadId,
      firstSummarizedMessageId: m0.id,
      lastSummarizedMessageId: m2.id,
      firstKeptMessageId: m3.id,
      summarizedMessageCount: 3,
    });

    const window = unwrap(
      await loadWindowedThreadMessages({ safeDb, threadId }),
    );

    expect(window.map((m) => m.id)).toEqual([m3.id, m4.id, m5.id]);
    expect(windowTexts(window)).toEqual(["m3", "m4", "m5"]);
  });

  test("includes the firstKept row when it shares a millisecond with summarized rows", async () => {
    const sameMs = new Date("2026-04-01T12:00:00.000Z").getTime();
    const { threadId, messages } = await seedThread(
      Array.from({ length: 6 }, (_, i) => ({
        createdAt: new Date(sameMs),
        text: `m${i}`,
      })),
    );
    // Order by (createdAt, id); since createdAt ties, id breaks the tie.
    const ascending = [...messages].sort(byId);
    const firstKept = ascending[3];
    if (!firstKept || !ascending[0] || !ascending[2]) {
      throw new Error("seed precondition failed");
    }
    await seedActiveCheckpoint({
      threadId,
      firstSummarizedMessageId: ascending[0].id,
      lastSummarizedMessageId: ascending[2].id,
      firstKeptMessageId: firstKept.id,
      summarizedMessageCount: 3,
    });

    const window = unwrap(
      await loadWindowedThreadMessages({ safeDb, threadId }),
    );

    // Despite all rows sharing a millisecond, the tuple boundary keeps exactly
    // [firstKept..end] in id order — no same-ms row is skipped or duplicated.
    expect(window.map((m) => m.id)).toEqual(
      ascending.slice(3).map((m) => m.id),
    );
  });

  test("caps at the most recent `limit` rows when no checkpoint exists", async () => {
    const base = Date.parse("2026-02-15T00:00:00.000Z");
    const { threadId, messages } = await seedThread(
      Array.from({ length: 6 }, (_, i) => ({
        createdAt: new Date(base + i),
        text: `m${i}`,
      })),
    );

    const window = unwrap(
      await loadWindowedThreadMessages({ safeDb, threadId, limit: 3 }),
    );

    // Only the most recent 3, ascending — a never-checkpointed (e.g.
    // anonymized) thread cannot load its full history per send.
    expect(window.map((m) => m.id)).toEqual(messages.slice(3).map((m) => m.id));
    expect(windowTexts(window)).toEqual(["m3", "m4", "m5"]);
  });

  test("caps within the checkpoint window when it exceeds `limit`", async () => {
    const base = Date.parse("2026-02-20T00:00:00.000Z");
    const { threadId, messages } = await seedThread(
      Array.from({ length: 6 }, (_, i) => ({
        createdAt: new Date(base + i),
        text: `m${i}`,
      })),
    );
    const [m0, m1] = messages;
    const m4 = messages[4];
    const m5 = messages[5];
    if (!m0 || !m1 || !m4 || !m5) {
      throw new Error("seed precondition failed");
    }
    await seedActiveCheckpoint({
      threadId,
      firstSummarizedMessageId: m0.id,
      lastSummarizedMessageId: m0.id,
      firstKeptMessageId: m1.id,
      summarizedMessageCount: 1,
    });

    const window = unwrap(
      await loadWindowedThreadMessages({ safeDb, threadId, limit: 2 }),
    );

    // Within the [m1..m5] checkpoint window, only the most recent 2 load.
    expect(window.map((m) => m.id)).toEqual([m4.id, m5.id]);
  });
});

describe("resolveTruncationTarget", () => {
  test("returns the retained prefix and delete set for a target older than the window", async () => {
    const base = Date.parse("2026-05-01T00:00:00.000Z");
    const { threadId, messages } = await seedThread(
      Array.from({ length: 6 }, (_, i) => ({
        createdAt: new Date(base + i),
        text: `m${i}`,
      })),
    );
    // Checkpoint keeps from m4; the truncation target m2 is older than that
    // window, so the resolver must reach past the window into the DB.
    const [m0, m1, m2, m3, m4, m5] = messages;
    if (!m0 || !m1 || !m2 || !m3 || !m4 || !m5) {
      throw new Error("seed precondition failed");
    }
    await seedActiveCheckpoint({
      threadId,
      firstSummarizedMessageId: m0.id,
      lastSummarizedMessageId: m3.id,
      firstKeptMessageId: m4.id,
      summarizedMessageCount: 4,
    });

    const resolved = unwrap(
      await resolveTruncationTarget({
        safeDb,
        threadId,
        targetMessageId: m2.id,
      }),
    );
    if (resolved === null) {
      throw new Error("expected the target to resolve");
    }

    // Retained prefix is m0..m2 (<= target), in ascending order.
    expect(resolved.messagesForPersistence.map((m) => m.id)).toEqual([
      m0.id,
      m1.id,
      m2.id,
    ]);
    // Delete set is m3..m5 (> target).
    expect(resolved.deleteMessageIdsBeforeLatest).toEqual([
      m3.id,
      m4.id,
      m5.id,
    ]);
  });

  test("returns null when the target id is not in the thread", async () => {
    const base = Date.parse("2026-05-10T00:00:00.000Z");
    const { threadId } = await seedThread([
      { createdAt: new Date(base), text: "only" },
    ]);

    const resolved = unwrap(
      await resolveTruncationTarget({
        safeDb,
        threadId,
        targetMessageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      }),
    );

    expect(resolved).toBeNull();
  });
});

describe("chatMessageExistsForThread", () => {
  test("detects a re-sent old message id outside the window (no duplicate)", async () => {
    const base = Date.parse("2026-06-01T00:00:00.000Z");
    const { threadId, messages } = await seedThread(
      Array.from({ length: 5 }, (_, i) => ({
        createdAt: new Date(base + i),
        text: `m${i}`,
      })),
    );
    const [oldId, , m2, firstKept] = messages;
    if (!oldId || !m2 || !firstKept) {
      throw new Error("seed precondition failed");
    }
    await seedActiveCheckpoint({
      threadId,
      firstSummarizedMessageId: oldId.id,
      lastSummarizedMessageId: m2.id,
      firstKeptMessageId: firstKept.id,
      summarizedMessageCount: 3,
    });

    const window = unwrap(
      await loadWindowedThreadMessages({ safeDb, threadId }),
    );
    // The old id is excluded from the per-send window.
    expect(window.some((m) => m.id === oldId.id)).toBe(false);

    // But the targeted existence check still detects it, so the dedup decision
    // can avoid a duplicate insert.
    const existsOld = unwrap(
      await chatMessageExistsForThread({
        messageId: oldId.id,
        safeDb,
        threadId,
      }),
    );
    expect(existsOld).toBe(true);

    const existsUnknown = unwrap(
      await chatMessageExistsForThread({
        messageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        safeDb,
        threadId,
      }),
    );
    expect(existsUnknown).toBe(false);
  });
});

describe("shouldCompactChatMessages", () => {
  test("is false under the trigger and true once the window crosses it", () => {
    const small = [
      {
        id: "a",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hi" }],
      },
    ];
    expect(shouldCompactChatMessages(small)).toBe(false);

    const large = [
      {
        id: "b",
        role: "user" as const,
        parts: [{ type: "text" as const, text: longText("fact") }],
      },
    ];
    expect(shouldCompactChatMessages(large)).toBe(true);
  });
});
