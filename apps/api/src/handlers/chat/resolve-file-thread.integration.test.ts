import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Logger } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { chatThreads, fileChatThreads } from "@/api/db/schema";
import { markRlsDatabase, createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  lockFileChatThreadMapping,
  readFileChatThreadMapping,
} from "./file-thread-mapping";
import { createFileChatThread } from "./file-thread-shared";

let testDb: TestDatabase;
let ids: TestIds;
let hiddenThreadId: SafeId<"chatThread">;
let queryCount = 0;
let loggedQueries: string[] = [];

const logger: Logger = {
  logQuery: (query) => {
    queryCount += 1;
    loggedQueries.push(query);
  },
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  hiddenThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());

  await testDb.insert(chatThreads).values({
    id: hiddenThreadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "Thread with inaccessible historical matter data",
    workspaceId: ids.wsA2,
    dataWorkspaceIds: [ids.wsA1, ids.wsA2],
  });
  await testDb.insert(fileChatThreads).values({
    id: toSafeId<"fileChatThread">(Bun.randomUUIDv7()),
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    userId: ids.userA1,
    entityId: ids.entityA2,
    fieldId: ids.fieldA2,
    chatThreadId: hiddenThreadId,
  });
});

afterAll(async () => {
  await testDb.delete(chatThreads).where(eq(chatThreads.id, hiddenThreadId));
  await releaseRlsFixture();
});

const lookup = async (
  {
    workspaceId,
    entityId,
    fieldId,
  }: {
    workspaceId: SafeId<"workspace">;
    entityId: SafeId<"entity">;
    fieldId: SafeId<"field">;
  },
  mappingLookup: typeof lockFileChatThreadMapping = lockFileChatThreadMapping,
) => {
  const countedDb = markRlsDatabase(
    drizzle({
      client: testDb.$client,
      logger,
    }),
  );
  const scopedDb = createScopedDb(
    countedDb,
    [workspaceId],
    ids.orgA,
    ids.userA1,
  );

  return await scopedDb(async (tx) => {
    queryCount = 0;
    loggedQueries = [];
    const mapping = await mappingLookup(asTestRaw<Transaction>(tx), {
      entityId,
      fieldId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      workspaceId,
    });
    return { mapping, queryCount, queries: loggedQueries };
  });
};

describe("file-thread mapping lookup", () => {
  test("locks and resolves an accessible thread in one query", async () => {
    const result = await lookup({
      workspaceId: ids.wsA1,
      entityId: ids.entityA1,
      fieldId: ids.fieldA1,
    });

    expect(result.queryCount).toBe(1);
    expect(result.mapping).toMatchObject({
      id: ids.fileChatThreadA1,
      mappedChatThreadId: ids.chatThreadWorkspaceA1,
      thread: { id: ids.chatThreadWorkspaceA1 },
    });
  });

  test("keeps the mapping visible when thread RLS hides the join", async () => {
    const result = await lookup({
      workspaceId: ids.wsA2,
      entityId: ids.entityA2,
      fieldId: ids.fieldA2,
    });

    expect(result.queryCount).toBe(1);
    expect(result.mapping).toMatchObject({
      mappedChatThreadId: hiddenThreadId,
      thread: null,
    });
  });

  test("the read variant resolves the same row without taking the row lock", async () => {
    // The read-only GET (`read-file-thread.ts`) runs on every document open;
    // if its lookup ever regained FOR UPDATE it would serialize document
    // opens against concurrent materializations, silently.
    const result = await lookup(
      {
        workspaceId: ids.wsA1,
        entityId: ids.entityA1,
        fieldId: ids.fieldA1,
      },
      readFileChatThreadMapping,
    );

    expect(result.queryCount).toBe(1);
    expect(result.mapping).toMatchObject({
      id: ids.fileChatThreadA1,
      mappedChatThreadId: ids.chatThreadWorkspaceA1,
      thread: { id: ids.chatThreadWorkspaceA1 },
    });
    expect(
      result.queries.some((query) =>
        query.toLowerCase().includes("for update"),
      ),
    ).toBe(false);
  });
});

const materialize = async (requestedThreadId: SafeId<"chatThread">) => {
  const scopedDb = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  return await scopedDb(async (tx) =>
    createFileChatThread(
      asTestRaw<Transaction>(tx),
      {
        entityId: ids.entityA1,
        fieldId: ids.fileFieldA1,
        organizationId: ids.orgA,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      },
      async () => {
        // Audit rows are covered by the handler-level tests; the adoption
        // logic under test never branches on them.
      },
      null,
      false,
      requestedThreadId,
    ),
  );
};

// Pre-send settings changes (update-thread-model / update-thread) upsert a
// placeholder chatThreads row under the client draft id before the first
// send materializes it. The materialization used to plain-insert that same
// id: unique violation, recovery finds no file mapping, and every send
// returned 404 forever.
describe("file-thread materialization with an occupied draft id", () => {
  test("adopts a same-owner placeholder and maps it", async () => {
    const draftId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    await testDb.insert(chatThreads).values({
      id: draftId,
      organizationId: ids.orgA,
      userId: ids.userA1,
      title: "New chat",
      workspaceId: ids.wsA1,
      dataWorkspaceIds: [ids.wsA1],
      chatModel: "placeholder-model",
    });

    try {
      const result = await materialize(draftId);

      expect(result).toMatchObject({ ok: true, chatThreadId: draftId });
      // The placeholder row was adopted, not recreated: its pre-send model
      // survives, while the title becomes the file's name.
      const adopted = await testDb.query.chatThreads.findFirst({
        where: { id: { eq: draftId } },
        columns: { title: true, chatModel: true },
      });
      expect(adopted).toEqual({
        title: "agreement-a.docx",
        chatModel: "placeholder-model",
      });
      // ...and is mapped, so a re-resolve finds it instead of 404ing.
      const mapped = await testDb
        .select({ chatThreadId: fileChatThreads.chatThreadId })
        .from(fileChatThreads)
        .where(eq(fileChatThreads.chatThreadId, draftId));
      expect(mapped).toHaveLength(1);
    } finally {
      await testDb
        .delete(fileChatThreads)
        .where(eq(fileChatThreads.chatThreadId, draftId));
      await testDb.delete(chatThreads).where(eq(chatThreads.id, draftId));
    }
  });

  test("never adopts a foreign-owner occupant", async () => {
    const foreignId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    await testDb.insert(chatThreads).values({
      id: foreignId,
      organizationId: ids.orgA,
      userId: ids.userA2,
      title: "Someone else's thread",
      workspaceId: ids.wsA1,
      dataWorkspaceIds: [ids.wsA1],
    });

    try {
      // Thread RLS hides another user's row, so the occupant lookup misses
      // and the insert collides; the handler's unique-violation recovery
      // turns that into a 404. What must never happen is a silent adoption
      // that maps someone else's thread onto this file. (The explicit
      // owner check in the adoption branch backstops any future widening
      // of thread visibility.)
      const result = await Result.tryPromise(
        async () => await materialize(foreignId),
      );
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.cause).toMatchObject({
          cause: { code: "23505" },
        });
      }
      const mapped = await testDb
        .select({ id: fileChatThreads.id })
        .from(fileChatThreads)
        .where(eq(fileChatThreads.chatThreadId, foreignId));
      expect(mapped).toHaveLength(0);
    } finally {
      await testDb.delete(chatThreads).where(eq(chatThreads.id, foreignId));
    }
  });
});
