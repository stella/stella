import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  decodeMessagePageCursor,
  loadChatMessagePage,
} from "@/api/handlers/chat/message-page";
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

// Exercises the real keyset SQL in loadChatMessagePage against PGlite, not
// just the cursor codec. The query compares the full-precision (createdAt, id)
// tuple in-DB against the boundary row, so a page cannot skip or duplicate
// rows that share a millisecond (e.g. inserted in one transaction). A
// millisecond-precision cursor would silently drop same-millisecond rows at a
// page boundary; the "share a millisecond" test fails on that regression.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;

  // A real RLS-scoped query over the test DB, presented as the SafeDb the
  // handler expects. The scoped query runs over PGlite, whose transaction
  // type differs from production only in the query-result driver (erased at
  // runtime), so it is cast to the production ScopedDb shape.
  const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  safeDb = toSafeDbMock(asTestRaw<ScopedDb>(scoped));
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    // Cascade removes the seeded messages; the fixture DB is shared.
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

type SeededMessage = { id: SafeId<"chatMessage">; createdAt: Date };

const seedThread = async (
  createdAts: Date[],
): Promise<{ threadId: SafeId<"chatThread">; messages: SeededMessage[] }> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "Cursor pagination test thread",
    workspaceId: ids.wsA1,
  });
  seededThreadIds.push(threadId);

  const rows = createdAts.map((createdAt, index) => ({
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    role: "user" as const,
    content: {
      version: 1 as const,
      data: [{ type: "text" as const, text: `message ${index}` }],
    },
    createdAt,
  }));
  if (rows.length > 0) {
    await testDb.insert(chatMessages).values(rows);
  }

  return {
    threadId,
    messages: rows.map((row) => ({ id: row.id, createdAt: row.createdAt })),
  };
};

// The DB orders by (createdAt DESC, id DESC); Postgres uuid order equals
// lexicographic order of the canonical string, so this matches in JS.
const byCreatedThenId = (a: SeededMessage, b: SeededMessage): number => {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
};

const expectedAscendingIds = (
  messages: SeededMessage[],
): SafeId<"chatMessage">[] =>
  [...messages].sort(byCreatedThenId).map((message) => message.id);

const loadPage = async (
  threadId: SafeId<"chatThread">,
  before?: SafeId<"chatMessage">,
) => {
  const result = await loadChatMessagePage({
    safeDb,
    threadId,
    userId: ids.userA1,
    before,
  });
  if (Result.isError(result)) {
    throw new TypeError(`loadChatMessagePage failed: ${result.error.message}`);
  }
  return result.value;
};

// Follow olderCursor back to the start, assembling the full ascending history.
// Recursive (not a loop) because each page's cursor comes from the previous
// page; pageSizes is in fetch order (newest page first).
const walkAllPages = async (threadId: SafeId<"chatThread">) => {
  const idsAscending: SafeId<"chatMessage">[] = [];
  const pageSizes: number[] = [];

  const fetchFrom = async (
    before: SafeId<"chatMessage"> | undefined,
  ): Promise<void> => {
    const page = await loadPage(threadId, before);
    pageSizes.push(page.messages.length);
    idsAscending.unshift(...page.messages.map((message) => message.id));
    if (!page.olderCursor) {
      return;
    }
    const decoded = decodeMessagePageCursor(page.olderCursor);
    if (!decoded) {
      throw new Error("olderCursor failed to decode");
    }
    await fetchFrom(decoded);
  };

  await fetchFrom(undefined);
  return { idsAscending, pageSizes };
};

describe("loadChatMessagePage keyset pagination", () => {
  test("returns an empty page with no cursor for a thread with no messages", async () => {
    const { threadId } = await seedThread([]);

    const page = await loadPage(threadId);

    expect(page.messages).toEqual([]);
    expect(page.olderCursor).toBeNull();
    expect(page.lastActivityAt).toBeNull();
  });

  test("returns one ascending page with no cursor when under a full page", async () => {
    const base = Date.parse("2026-02-01T00:00:00.000Z");
    const { threadId, messages } = await seedThread(
      Array.from({ length: 5 }, (_, i) => new Date(base + i)),
    );

    const page = await loadPage(threadId);

    expect(page.messages.map((message) => message.id)).toEqual(
      expectedAscendingIds(messages),
    );
    expect(page.olderCursor).toBeNull();
    expect(page.lastActivityAt).toBe(new Date(base + 4).toISOString());
  });

  test("walks every message across pages with no gaps or duplicates", async () => {
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    const { threadId, messages } = await seedThread(
      Array.from({ length: 120 }, (_, i) => new Date(base + i)),
    );

    const { idsAscending, pageSizes } = await walkAllPages(threadId);

    expect(idsAscending).toEqual(expectedAscendingIds(messages));
    expect(pageSizes).toEqual([50, 50, 20]);
    expect(new Set(idsAscending).size).toBe(120);
  });

  test("does not skip rows that share a millisecond across a page boundary", async () => {
    const sameMs = new Date("2026-04-01T12:00:00.000Z").getTime();
    const { threadId, messages } = await seedThread(
      Array.from({ length: 70 }, () => new Date(sameMs)),
    );

    const { idsAscending, pageSizes } = await walkAllPages(threadId);

    expect(idsAscending).toEqual(expectedAscendingIds(messages));
    expect(pageSizes).toEqual([50, 20]);
    expect(new Set(idsAscending).size).toBe(70);
  });
});
